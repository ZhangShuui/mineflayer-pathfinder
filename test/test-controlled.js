/**
 * Controlled A/B Test v6: Dense canopy gauntlet on slope
 *
 * Key insight from analysis: stuck requires accumulated delay from MANY consecutive
 * dangerous diags in a SHORT path segment, exceeding the 3.5s stuck timer.
 * Single-intermediate leaf collisions are recoverable (bot slides to clear side).
 * Need VERY dense leaf coverage so every diagonal move has a dangerous intermediate.
 *
 * Design:
 * - Moderate slope (1 block per 3 z)
 * - Central "gauntlet" zone with ~60% head-height leaf density
 * - Clear entry/exit zones
 * - Routes forced through the gauntlet
 * - Dense coverage → many consecutive dangerous diags → cumulative delay → stuck
 */
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('./index')
const { GoalNear } = goals
const Vec3 = require('vec3')
const Move = require('./lib/move')

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'PathBot', version: '1.20.4'
})
bot.loadPlugin(pathfinder)

const BX = 11000, BY = 64, BZ = 11200
const FIELD_W = 20, FIELD_D = 40

// Ground height: moderate slope
function groundY (dz) { return BY + Math.floor(dz / 3) }

// Dense leaf pattern: ~60% coverage but ensuring connected clear paths
// Clear positions form a winding path so bot can navigate but must diagonal
function hasLeaf (dx, dz) {
  // Create clear "channels" that wind through the field
  // Channel 1: roughly follows dx = dz % 4 + offsets
  // Channel 2: roughly follows dx = FIELD_W - 1 - (dz % 4)
  // Everything else gets leaves

  // Clear channel positions (about 40% clear, 60% leaves)
  const phase = dz % 6
  const cx1 = (Math.floor(dz / 6) * 3 + phase) % FIELD_W  // winding channel 1
  const cx2 = (FIELD_W - 1 - (Math.floor(dz / 6) * 3 + phase) % FIELD_W) // channel 2

  // Clear within 1 block of either channel
  if (Math.abs(dx - cx1) <= 1) return false
  if (Math.abs(dx - cx2) <= 1) return false
  // Also clear every 4th column (provides connectivity)
  if (dx % 4 === 0) return false

  return true // leaf
}

bot.once('spawn', async () => {
  console.log('[Bot] Spawned')
  await sleep(5000)
  await safeTP(bot, BX + 10, BY + 10, BZ + 20)

  console.log('Building dense canopy gauntlet on slope...')

  // === CLEAR AREA ===
  const maxGY = groundY(FIELD_D - 1)
  for (let dx = 0; dx < FIELD_W; dx += 16) {
    for (let dz = 0; dz < FIELD_D; dz += 16) {
      const x2 = Math.min(BX + dx + 15, BX + FIELD_W - 1)
      const z2 = Math.min(BZ + dz + 15, BZ + FIELD_D - 1)
      bot.chat(`/fill ${BX + dx} ${BY - 1} ${BZ + dz} ${x2} ${maxGY + 4} ${z2} air`)
      await sleep(100)
      bot.chat(`/fill ${BX + dx} ${BY - 1} ${BZ + dz} ${x2} ${BY - 1} ${z2} stone`)
      await sleep(100)
    }
  }
  await sleep(500)

  // === BUILD SLOPE ===
  for (let dz = 0; dz < FIELD_D; dz++) {
    const gy = groundY(dz)
    bot.chat(`/fill ${BX} ${BY - 1} ${BZ + dz} ${BX + FIELD_W - 1} ${gy} ${BZ + dz} stone`)
    await sleep(50)
  }
  await sleep(500)

  // === PLACE DENSE LEAVES AT HEAD HEIGHT ===
  let leafCount = 0, clearCount = 0
  for (let dz = 3; dz < FIELD_D - 3; dz++) {  // gauntlet zone: z=3 to z=36
    for (let dx = 0; dx < FIELD_W; dx++) {
      if (hasLeaf(dx, dz)) {
        const gy = groundY(dz)
        bot.chat(`/setblock ${BX + dx} ${gy + 2} ${BZ + dz} oak_leaves[persistent=true]`)
        leafCount++
        if (leafCount % 30 === 0) await sleep(100)
      } else {
        clearCount++
      }
    }
  }
  console.log(`Placed ${leafCount} leaf blocks, ${clearCount} clear positions (${(leafCount/(leafCount+clearCount)*100).toFixed(0)}% density)`)

  await sleep(1000)

  // Reload chunks
  console.log('Reloading chunks...')
  bot.chat('/tp @s 0 200 0')
  await sleep(5000)
  await safeTP(bot, BX + 10, BY + 5, BZ + 20)
  await sleep(5000)

  // Verify
  let verified = 0
  for (let dx = 0; dx < FIELD_W; dx++)
    for (let dz = 0; dz < FIELD_D; dz++) {
      const b = bot.blockAt(new Vec3(BX + dx, groundY(dz) + 2, BZ + dz))
      if (b && b.name && b.name.includes('leaves')) verified++
    }
  console.log(`Verified ${verified} leaf blocks\n`)

  // === GENERATE ROUTES ===
  const routes = []

  // Routes going UPHILL through gauntlet (most likely to accumulate delay)
  for (let sx = 1; sx < FIELD_W - 1; sx += 3) {
    for (let gx = 1; gx < FIELD_W - 1; gx += 4) {
      const sp = findClearSpot(bot, BX + sx, BZ + 1, 2)
      const gp = findClearSpot(bot, BX + gx, BZ + FIELD_D - 2, 3)
      if (sp && gp && sp.distanceTo(gp) > 15) {
        routes.push({ sx: sp.x, sy: sp.y, sz: sp.z, gx: gp.x, gy: gp.y, gz: gp.z,
          desc: `Up x${sx}→x${gx}` })
      }
    }
  }

  // Routes going DOWNHILL (reversed)
  for (let sx = 1; sx < FIELD_W - 1; sx += 4) {
    for (let gx = 1; gx < FIELD_W - 1; gx += 5) {
      const sp = findClearSpot(bot, BX + sx, BZ + FIELD_D - 2, 3)
      const gp = findClearSpot(bot, BX + gx, BZ + 1, 2)
      if (sp && gp && sp.distanceTo(gp) > 15) {
        routes.push({ sx: sp.x, sy: sp.y, sz: sp.z, gx: gp.x, gy: gp.y, gz: gp.z,
          desc: `Down x${sx}→x${gx}` })
      }
    }
  }

  // Diagonal routes across gauntlet
  for (let i = 0; i < 8; i++) {
    const sx = 2 + i * 2, sz = 2 + i
    const gx = FIELD_W - 3 - i, gz = FIELD_D - 3 - i
    const sp = findClearSpot(bot, BX + sx, BZ + sz, 2)
    const gp = findClearSpot(bot, BX + gx, BZ + gz, 3)
    if (sp && gp && sp.distanceTo(gp) > 10) {
      routes.push({ sx: sp.x, sy: sp.y, sz: sp.z, gx: gp.x, gy: gp.y, gz: gp.z,
        desc: `Diag (${sx},${sz})→(${gx},${gz})` })
    }
  }

  // De-dup
  const seen = new Set()
  const unique = routes.filter(r => {
    const k = `${r.sx},${r.sy},${r.sz}-${r.gx},${r.gy},${r.gz}`
    if (seen.has(k)) return false; seen.add(k); return true
  })
  console.log(`Testing ${unique.length} routes\n`)

  // === RUN A/B TESTS ===
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  CONTROLLED A/B: Dense canopy gauntlet on slope            ║')
  console.log('║  canDig=false, 60%+ leaf density, accumulated collision    ║')
  console.log('╚══════════════════════════════════════════════════════════════╝\n')

  const allResults = []
  for (let i = 0; i < unique.length; i++) {
    const r = unique[i]
    console.log(`━━━ Route ${i + 1}/${unique.length}: ${r.desc} ━━━`)

    const origMov = new Movements(bot)
    origMov.canDig = false; origMov.allowSprinting = true
    patchOriginalDiagonal(origMov)
    await safeTP(bot, r.sx, r.sy, r.sz)
    const origResult = await runSingleTest(bot, origMov, 'ORIG', r.gx, r.gy, r.gz, 30000)

    const fixedMov = new Movements(bot)
    fixedMov.canDig = false; fixedMov.allowSprinting = true
    await safeTP(bot, r.sx, r.sy, r.sz)
    const fixedResult = await runSingleTest(bot, fixedMov, 'FIXED', r.gx, r.gy, r.gz, 30000)

    printRow(origResult, fixedResult)
    const v = getVerdict(origResult, fixedResult)
    if (v) console.log(`  >> ${v}`)
    console.log()
    allResults.push({ desc: r.desc, orig: origResult, fixed: fixedResult })
  }

  printFinalSummary(allResults)
  bot.quit(); await sleep(500); process.exit(0)
})

function findClearSpot (bot, x, z, radius) {
  const dz = z - BZ
  let best = null, bestDist = Infinity
  for (let ddx = -radius; ddx <= radius; ddx++)
    for (let ddz = -radius; ddz <= radius; ddz++) {
      const cx = x + ddx, cz = z + ddz
      const cdz = cz - BZ
      if (cdz < 0 || cdz >= FIELD_D || cx < BX || cx >= BX + FIELD_W) continue
      const gy = groundY(cdz)
      const cy = gy + 1
      const below = bot.blockAt(new Vec3(cx, gy, cz))
      const at = bot.blockAt(new Vec3(cx, cy, cz))
      const above = bot.blockAt(new Vec3(cx, cy + 1, cz))
      if (below && below.boundingBox === 'block' &&
          at && at.boundingBox === 'empty' &&
          above && above.boundingBox === 'empty') {
        const d = Math.abs(ddx) + Math.abs(ddz)
        if (d < bestDist) { bestDist = d; best = new Vec3(cx, cy, cz) }
      }
    }
  return best
}

async function safeTP (bot, x, y, z) {
  bot.pathfinder.setGoal(null)
  await sleep(200)
  bot.chat(`/tp @s ${x + 0.5} 300 ${z + 0.5}`)
  await sleep(400)
  bot.chat(`/tp @s ${x + 0.5} ${y} ${z + 0.5}`)
  await sleep(1200)
}

async function runSingleTest (bot, movements, label, gx, gy, gz, timeout) {
  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(null)
  await sleep(200)

  let resets = 0, stuck = 0, dangerDiags = 0
  const posLog = []
  const startPos = bot.entity.position.clone()

  const resetH = (reason) => { resets++; if (reason === 'stuck') stuck++ }
  const pathH = (r) => {
    if (!r.path) return
    for (let i = 1; i < r.path.length; i++) {
      const prev = r.path[i - 1], curr = r.path[i]
      const ddx = Math.round(curr.x - prev.x), ddz = Math.round(curr.z - prev.z)
      if (Math.abs(ddx) === 1 && Math.abs(ddz) === 1) {
        const px = Math.floor(prev.x), py = Math.floor(prev.y), pz = Math.floor(prev.z)
        const ddy = Math.round(curr.y - prev.y)
        const yBase = ddy > 0 ? 1 : 0
        for (const dy of [yBase, yBase + 1]) {
          const h1 = bot.blockAt(new Vec3(px, py + dy, pz + ddz))
          const h2 = bot.blockAt(new Vec3(px + ddx, py + dy, pz))
          if ((h1 && h1.boundingBox === 'block') || (h2 && h2.boundingBox === 'block')) {
            dangerDiags++; break
          }
        }
      }
    }
  }
  const posI = setInterval(() => { if (bot.entity) posLog.push(bot.entity.position.clone()) }, 500)
  bot.on('path_reset', resetH)
  bot.on('path_update', pathH)

  const t0 = Date.now()
  let status = 'PASS', errMsg = ''
  try {
    await Promise.race([
      bot.pathfinder.goto(new GoalNear(gx, gy, gz, 2)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    ])
  } catch (err) {
    errMsg = err.message || String(err)
    if (errMsg === 'Timeout') {
      status = (posLog.length >= 6 && maxDist(posLog.slice(-6)) < 2) ? 'STUCK' : 'SLOW'
    } else if (errMsg.includes('NoPath') || errMsg.includes('noPath') || errMsg.includes('Goal')) {
      status = 'NOPATH'
    } else {
      status = 'ERR'
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  clearInterval(posI)
  bot.removeListener('path_reset', resetH)
  bot.removeListener('path_update', pathH)
  bot.pathfinder.setGoal(null)
  await sleep(200)

  const endPos = bot.entity.position
  const goalDist = endPos.distanceTo(new Vec3(gx, gy, gz)).toFixed(1)
  const moved = startPos.distanceTo(endPos).toFixed(1)
  const icon = status === 'PASS' ? '✓' : '✗'
  console.log(`  ${icon} [${label}] ${status} ${elapsed}s | stuck=${stuck} ddiags=${dangerDiags} resets=${resets} moved=${moved} goalDist=${goalDist}`)
  if (status !== 'PASS') {
    const sp = startPos.floored()
    const below = bot.blockAt(new Vec3(sp.x, sp.y - 1, sp.z))
    const at = bot.blockAt(new Vec3(sp.x, sp.y, sp.z))
    const above = bot.blockAt(new Vec3(sp.x, sp.y + 1, sp.z))
    console.log(`    diag: start=${sp} below=${below ? below.name : '?'} at=${at ? at.name : '?'} above=${above ? above.name : '?'} err=${errMsg}`)
  }
  return { status, time: elapsed, stuck, dangerDiags, resets, moved, goalDist, errMsg }
}

function maxDist (positions) {
  let m = 0
  for (let i = 0; i < positions.length; i++)
    for (let j = i + 1; j < positions.length; j++)
      m = Math.max(m, positions[i].distanceTo(positions[j]))
  return m
}

function patchOriginalDiagonal (movements) {
  movements.getMoveDiagonal = function (node, dir, neighbors) {
    let cost = Math.SQRT2
    const toBreak = []
    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const y = blockC.physical ? 1 : 0
    const block0 = this.getBlock(node, 0, -1, 0)
    let cost1 = 0; const toBreak1 = []
    const blockB1 = this.getBlock(node, 0, y + 1, dir.z)
    const blockC1 = this.getBlock(node, 0, y, dir.z)
    const blockD1 = this.getBlock(node, 0, y - 1, dir.z)
    cost1 += this.safeOrBreak(blockB1, toBreak1)
    cost1 += this.safeOrBreak(blockC1, toBreak1)
    if (blockD1.height - block0.height > 1.2) cost1 += this.safeOrBreak(blockD1, toBreak1)
    let cost2 = 0; const toBreak2 = []
    const blockB2 = this.getBlock(node, dir.x, y + 1, 0)
    const blockC2 = this.getBlock(node, dir.x, y, 0)
    const blockD2 = this.getBlock(node, dir.x, y - 1, 0)
    cost2 += this.safeOrBreak(blockB2, toBreak2)
    cost2 += this.safeOrBreak(blockC2, toBreak2)
    if (blockD2.height - block0.height > 1.2) cost2 += this.safeOrBreak(blockD2, toBreak2)
    if (cost1 < cost2) { cost += cost1; toBreak.push(...toBreak1) }
    else { cost += cost2; toBreak.push(...toBreak2) }
    if (cost > 100) return
    cost += this.safeOrBreak(this.getBlock(node, dir.x, y, dir.z), toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(this.getBlock(node, dir.x, y + 1, dir.z), toBreak)
    if (cost > 100) return
    if (this.getBlock(node, 0, 0, 0).liquid) cost += this.liquidCost
    const blockD = this.getBlock(node, dir.x, -1, dir.z)
    if (y === 1) {
      if (blockC.height - block0.height > 1.2) return
      cost += this.safeOrBreak(this.getBlock(node, 0, 2, 0), toBreak)
      if (cost > 100) return; cost += 1
      neighbors.push(new Move(blockC.position.x, blockC.position.y + 1, blockC.position.z, node.remainingBlocks, cost, toBreak))
    } else if (blockD.physical || blockC.liquid) {
      neighbors.push(new Move(blockC.position.x, blockC.position.y, blockC.position.z, node.remainingBlocks, cost, toBreak))
    } else if (this.getBlock(node, dir.x, -2, dir.z).physical || blockD.liquid) {
      if (!blockD.safe) return
      cost += this.getNumEntitiesAt(blockC.position, 0, -1, 0) * this.entityCost
      neighbors.push(new Move(blockC.position.x, blockC.position.y - 1, blockC.position.z, node.remainingBlocks, cost, toBreak))
    }
  }
}

function printRow (orig, fixed) {
  console.log('  ┌─────────────┬────────┬────────┬────────┬──────────┬─────────┐')
  console.log('  │ Version     │ Status │ Time   │ Stuck  │ DangDiag │ Resets  │')
  console.log('  ├─────────────┼────────┼────────┼────────┼──────────┼─────────┤')
  console.log(`  │ ORIGINAL    │ ${pad(orig.status, 6)} │ ${pad(orig.time + 's', 6)} │ ${pad(orig.stuck, 6)} │ ${pad(orig.dangerDiags, 8)} │ ${pad(orig.resets, 7)} │`)
  console.log(`  │ FIXED       │ ${pad(fixed.status, 6)} │ ${pad(fixed.time + 's', 6)} │ ${pad(fixed.stuck, 6)} │ ${pad(fixed.dangerDiags, 8)} │ ${pad(fixed.resets, 7)} │`)
  console.log('  └─────────────┴────────┴────────┴────────┴──────────┴─────────┘')
}

function getVerdict (orig, fixed) {
  const v = [], fs = ['STUCK', 'SLOW', 'ERR', 'NOPATH']
  if (fs.includes(orig.status) && fixed.status === 'PASS') v.push('★ ORIG FAIL, FIXED PASS')
  if (orig.status === 'PASS' && fs.includes(fixed.status)) v.push('✗ REGRESSION')
  if (orig.stuck > 0 && fixed.stuck === 0 && fixed.status === 'PASS') v.push(`STUCK FIX: orig stuck ${orig.stuck}x`)
  return v.join(' | ') || null
}

function printFinalSummary (results) {
  const o = { pass: 0, fail: 0, stuck: 0, nopath: 0, resets: 0, diags: 0 }
  const f = { pass: 0, fail: 0, stuck: 0, nopath: 0, resets: 0, diags: 0 }
  let imp = 0, reg = 0
  const fs = ['STUCK', 'SLOW', 'ERR', 'NOPATH']
  for (const r of results) {
    r.orig.status === 'PASS' ? o.pass++ : o.fail++
    r.fixed.status === 'PASS' ? f.pass++ : f.fail++
    if (r.orig.status === 'STUCK') o.stuck++; if (r.fixed.status === 'STUCK') f.stuck++
    if (r.orig.status === 'NOPATH') o.nopath++; if (r.fixed.status === 'NOPATH') f.nopath++
    o.resets += r.orig.resets; o.diags += r.orig.dangerDiags
    f.resets += r.fixed.resets; f.diags += r.fixed.dangerDiags
    if (fs.includes(r.orig.status) && r.fixed.status === 'PASS') imp++
    if (r.orig.status === 'PASS' && fs.includes(r.fixed.status)) reg++
  }
  const n = results.length
  console.log('\n' + '═'.repeat(60))
  console.log('  FINAL SUMMARY')
  console.log('═'.repeat(60))
  console.log(`  Routes tested: ${n}\n`)
  console.log('  ┌────────────────────┬──────────────┬──────────────┐')
  console.log('  │ Metric             │ ORIGINAL     │ FIXED        │')
  console.log('  ├────────────────────┼──────────────┼──────────────┤')
  console.log(`  │ Passed             │ ${pad(o.pass + '/' + n, 12)} │ ${pad(f.pass + '/' + n, 12)} │`)
  console.log(`  │ Failed             │ ${pad(o.fail, 12)} │ ${pad(f.fail, 12)} │`)
  console.log(`  │ Stuck              │ ${pad(o.stuck, 12)} │ ${pad(f.stuck, 12)} │`)
  console.log(`  │ NoPath             │ ${pad(o.nopath, 12)} │ ${pad(f.nopath, 12)} │`)
  console.log(`  │ Path resets        │ ${pad(o.resets, 12)} │ ${pad(f.resets, 12)} │`)
  console.log(`  │ Danger diagonals   │ ${pad(o.diags, 12)} │ ${pad(f.diags, 12)} │`)
  console.log('  └────────────────────┴──────────────┴──────────────┘\n')
  console.log(`  ★ Fix improved (ORIG fail→FIXED pass): ${imp}`)
  console.log(`  ✗ Regressions (ORIG pass→FIXED fail):  ${reg}\n`)

  // Timing comparison
  let origTotal = 0, fixedTotal = 0, bothPass = 0
  for (const r of results) {
    if (r.orig.status === 'PASS' && r.fixed.status === 'PASS') {
      origTotal += parseFloat(r.orig.time)
      fixedTotal += parseFloat(r.fixed.time)
      bothPass++
    }
  }
  if (bothPass > 0) {
    console.log(`  Timing (routes where both pass):`)
    console.log(`    ORIGINAL avg: ${(origTotal/bothPass).toFixed(1)}s`)
    console.log(`    FIXED avg:    ${(fixedTotal/bothPass).toFixed(1)}s`)
    console.log(`    Diff:         ${(origTotal-fixedTotal).toFixed(1)}s total (${((origTotal-fixedTotal)/origTotal*100).toFixed(1)}% ${origTotal > fixedTotal ? 'slower' : 'faster'} orig)\n`)
  }

  const key = results.filter(r =>
    (fs.includes(r.orig.status) && r.fixed.status === 'PASS') ||
    (r.orig.status === 'PASS' && fs.includes(r.fixed.status))
  )
  if (key.length > 0) {
    console.log('  Key routes:')
    for (const r of key) {
      const tag = fs.includes(r.orig.status) && r.fixed.status === 'PASS' ? '★' : '✗'
      console.log(`    ${tag} ${r.desc}: ORIG=${r.orig.status}(dd=${r.orig.dangerDiags},stuck=${r.orig.stuck}) FIXED=${r.fixed.status}(dd=${r.fixed.dangerDiags},stuck=${r.fixed.stuck})`)
    }
  }

  const ff = results.filter(r => r.fixed.status !== 'PASS')
  if (ff.length > 0) {
    console.log('\n  Fixed version failures:')
    for (const r of ff) {
      const alsoOrig = r.orig.status !== 'PASS' ? ' (ORIG also failed)' : ' ✗ REGRESSION'
      console.log(`    ${r.desc}: ${r.fixed.status} goalDist=${r.fixed.goalDist}${alsoOrig}`)
    }
  }

  console.log('\n' + (imp > 0 && reg === 0 ? `  CONCLUSION: Fix EFFECTIVE — ${imp} routes saved, zero regressions` :
    imp > reg ? `  CONCLUSION: Net positive — ${imp} improved vs ${reg} regressed` :
    reg > 0 ? `  CONCLUSION: Has regressions — ${reg} routes worse` :
    '  CONCLUSION: No significant difference in success rate'))
  console.log('═'.repeat(60))
}

function pad (v, n) { return String(v).padEnd(n) }
function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
bot.on('error', (err) => console.error('[Bot Error]', err.message))
bot.on('kicked', (reason) => console.log('[Kicked]', reason))
