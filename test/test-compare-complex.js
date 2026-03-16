/**
 * Rigorous A/B Comparison: Original vs Fixed Diagonal Movement
 *
 * Strategy: Focus on ONE dense forest area with hilly terrain.
 * Test 80 routes through leaf-dense paths.
 * Single forest = no cross-area teleporting = no server crashes.
 * Tracks: pass/fail, timing, retry counts, dangerous diags.
 */

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('./index')
const { GoalNear } = goals
const Vec3 = require('vec3')
const Move = require('./lib/move')

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'PathBot',
  version: '1.20.4'
})

bot.loadPlugin(pathfinder)

bot.once('spawn', async () => {
  console.log('[Bot] Spawned at', bot.entity.position.toString())
  await sleep(5000)

  const mcData = require('minecraft-data')(bot.version)

  // Search for the best forest — expanded search grid
  const searchLocations = [
    [400, 0], [300, 300], [-300, 300], [-300, -300],
    [0, 0], [200, 200], [-200, 200], [200, -200],
    [500, 500], [-500, 500], [100, 300], [300, 100],
    [600, 0], [0, 600], [-600, 600], [150, 150],
    [800, 0], [0, 800], [-800, 0], [0, -800],
    [700, 300], [-700, 300], [300, 700], [-300, -700],
    [1000, 0], [0, 1000], [-1000, 0], [0, -1000],
    [450, 450], [-450, 450], [650, 200], [-200, 650]
  ]

  let bestForest = null
  console.log('Searching for best forest...')
  for (const [tx, tz] of searchLocations) {
    bot.chat(`/tp @s ${tx} 100 ${tz}`)
    await sleep(3000)
    const spawn = bot.entity.position.floored()
    const result = findForestInfo(bot, spawn, mcData, 60)
    console.log(`  (${tx}, ${tz}) → ${result.trees.length} trees, ${result.leafHeadCount} head-leaves`)

    if (!bestForest || result.leafHeadCount > bestForest.leafHeadCount ||
        (result.leafHeadCount === bestForest.leafHeadCount && result.trees.length > bestForest.trees.length)) {
      bestForest = { spawn, ...result }
    }
    // Don't early-break — always search all locations to find best
  }

  if (!bestForest || bestForest.trees.length < 3) {
    console.log('No suitable forest found. Exiting.')
    bot.quit(); process.exit(1)
  }

  // Stay in this forest
  bot.chat(`/tp @s ${bestForest.spawn.x} ${bestForest.spawn.y} ${bestForest.spawn.z}`)
  await sleep(3000)

  const trees = bestForest.trees
  const leafPositions = bestForest.leafPositions
  console.log(`\nBest forest: ${bestForest.spawn} — ${trees.length} trees, ${bestForest.leafHeadCount} head-leaves, ${leafPositions.length} leaf positions`)
  console.log('Trees:', trees.slice(0, 15).map((t, i) => `#${i}(${t.x},${t.y},${t.z})`).join(', '))

  // Generate ALL possible routes through leaf-dense areas
  const routes = []

  // Type A: Tree-to-tree
  for (let i = 0; i < trees.length; i++) {
    for (let j = i + 1; j < trees.length; j++) {
      const dist = trees[i].distanceTo(trees[j])
      if (dist < 3 || dist > 30) continue
      const s = findNearestSafeSpot(bot, trees[i], 3)
      const g = findNearestSafeSpot(bot, trees[j], 3)
      if (!s || !g || s.distanceTo(g) < 3) continue
      const lv = countLeavesAlongLine(bot, s, g)
      if (lv >= 1) {
        routes.push({ sx: s.x, sy: s.y, sz: s.z, gx: g.x, gy: g.y, gz: g.z, lv, desc: `T${i}→T${j} (${dist.toFixed(0)}m,${lv}lv)` })
      }
    }
  }

  // Type B: Around trees (all 4 diagonal directions)
  for (let i = 0; i < trees.length; i++) {
    for (const [ox1, oz1, ox2, oz2] of [[-4, -4, 4, 4], [4, -4, -4, 4], [-4, 0, 4, 0], [0, -4, 0, 4], [-3, -3, 3, 3], [3, -3, -3, 3]]) {
      const s = findNearestSafeSpot(bot, new Vec3(trees[i].x + ox1, trees[i].y, trees[i].z + oz1), 3)
      const g = findNearestSafeSpot(bot, new Vec3(trees[i].x + ox2, trees[i].y, trees[i].z + oz2), 3)
      if (!s || !g || s.distanceTo(g) < 4) continue
      const lv = countLeavesAlongLine(bot, s, g)
      if (lv >= 1) {
        routes.push({ sx: s.x, sy: s.y, sz: s.z, gx: g.x, gy: g.y, gz: g.z, lv, desc: `Around#${i} (${lv}lv)` })
      }
    }
  }

  // Type C: Leaf-to-leaf
  for (let i = 0; i < Math.min(leafPositions.length, 25); i++) {
    for (let j = i + 1; j < Math.min(leafPositions.length, 25); j++) {
      const dist = leafPositions[i].distanceTo(leafPositions[j])
      if (dist < 4 || dist > 20) continue
      const s = findNearestSafeSpot(bot, leafPositions[i].offset(0, -1, 0), 3)
      const g = findNearestSafeSpot(bot, leafPositions[j].offset(0, -1, 0), 3)
      if (!s || !g || s.distanceTo(g) < 3) continue
      const lv = countLeavesAlongLine(bot, s, g)
      if (lv >= 2) {
        routes.push({ sx: s.x, sy: s.y, sz: s.z, gx: g.x, gy: g.y, gz: g.z, lv, desc: `L${i}→L${j} (${dist.toFixed(0)}m,${lv}lv)` })
      }
    }
  }

  // De-dup, sort by leaf density, take top 80
  const seen = new Set()
  const unique = routes.filter(r => {
    const key = `${r.sx},${r.sy},${r.sz}-${r.gx},${r.gy},${r.gz}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
  unique.sort((a, b) => b.lv - a.lv)
  const testRoutes = unique.slice(0, 80)

  console.log(`Generated ${unique.length} routes, testing ${testRoutes.length}`)
  console.log()

  // ════════════════════════════════════════════════
  //  RUN A/B TESTS
  // ════════════════════════════════════════════════
  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║  A/B COMPARISON: Original vs Fixed (all fixes)           ║')
  console.log('║  canDig=false, natural forest terrain                   ║')
  console.log('╚════════════════════════════════════════════════════════════╝\n')

  const allResults = []

  for (let i = 0; i < testRoutes.length; i++) {
    const r = testRoutes[i]
    console.log(`━━━ Route ${i + 1}/${testRoutes.length}: ${r.desc} ━━━`)

    // ── ORIGINAL (upstream behavior: old diagonal + no leaf breaking) ──
    const origMov = new Movements(bot)
    origMov.canDig = false
    origMov.allowSprinting = true
    origMov.allowBreakLeaves = false // upstream has no leaf breaking
    patchOriginalDiagonal(origMov)
    await safeTP(bot, r.sx, r.sy, r.sz)
    const origResult = await runSingleTest(bot, origMov, 'ORIG', r.gx, r.gy, r.gz, 20000)

    // ── FIXED (all fixes: new diagonal + allowBreakLeaves) ──
    const fixedMov = new Movements(bot)
    fixedMov.canDig = false
    fixedMov.allowSprinting = true
    // allowBreakLeaves defaults to true — our full fix
    await safeTP(bot, r.sx, r.sy, r.sz)
    const fixedResult = await runSingleTest(bot, fixedMov, 'FIXED', r.gx, r.gy, r.gz, 20000)

    printRow(origResult, fixedResult)
    const v = getVerdict(origResult, fixedResult)
    if (v) console.log(`  >> ${v}`)
    console.log()
    allResults.push({ desc: r.desc, route: r, orig: origResult, fixed: fixedResult })
  }

  printFinalSummary(allResults)

  // ════════════════════════════════════════════════
  //  VISUALIZATION PHASE: Re-run interesting routes with terrain + path tracking
  // ════════════════════════════════════════════════
  const failStatuses = ['STUCK', 'SLOW', 'ERR', 'NOPATH']
  const vizCandidates = allResults.filter(r =>
    (failStatuses.includes(r.orig.status) && r.fixed.status === 'PASS') ||
    (r.orig.status === 'PASS' && failStatuses.includes(r.fixed.status)) ||
    r.orig.dangerDiags >= 5
  )
  // Add some clean contrast routes
  const cleanRoutes = allResults.filter(r => r.orig.status === 'PASS' && r.fixed.status === 'PASS' && r.orig.dangerDiags === 0).slice(0, 2)
  const vizRoutes = [...vizCandidates.slice(0, 8), ...cleanRoutes]

  if (vizRoutes.length > 0) {
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`  VISUALIZATION PHASE: Re-running ${vizRoutes.length} routes with path tracking`)
    console.log('═'.repeat(60) + '\n')

    const vizData = []
    for (let i = 0; i < vizRoutes.length; i++) {
      const { desc, route: r } = vizRoutes[i]
      console.log(`  [viz ${i + 1}/${vizRoutes.length}] ${desc}`)

      // Scan terrain
      const terrain = scanTerrain(bot, r)

      // Run ORIG with path tracking
      const origMov = new Movements(bot)
      origMov.canDig = false; origMov.allowSprinting = true; origMov.allowBreakLeaves = false
      patchOriginalDiagonal(origMov)
      await safeTP(bot, r.sx, r.sy, r.sz)
      const origViz = await runTrackedTest(bot, origMov, r, 20000)
      console.log(`    ORIG: ${origViz.status} ${origViz.time}s dd=${origViz.dangerDiags}`)

      // Run FIXED with path tracking
      const fixedMov = new Movements(bot)
      fixedMov.canDig = false; fixedMov.allowSprinting = true
      await safeTP(bot, r.sx, r.sy, r.sz)
      const fixedViz = await runTrackedTest(bot, fixedMov, r, 20000)
      console.log(`    FIXED: ${fixedViz.status} ${fixedViz.time}s dd=${fixedViz.dangerDiags}`)

      vizData.push({
        name: desc, leafCount: r.lv,
        start: { x: r.sx, y: r.sy, z: r.sz },
        goal: { x: r.gx, y: r.gy, z: r.gz },
        terrain, orig: origViz, fixed: fixedViz
      })
    }

    // Generate HTML
    const html = generateVizHTML(vizData)
    require('fs').writeFileSync('viz-pathfinder.html', html)
    console.log('\n  Visualization saved to viz-pathfinder.html')
  }

  bot.quit(); await sleep(500); process.exit(0)
})

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
        // Account for step-up moves: if destination is higher, intermediates
        // are checked 1 block higher (bot jumps before moving diagonally)
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
    } else if (errMsg.includes('NoPath') || errMsg.includes('noPath')) {
      status = 'NOPATH'
    } else if (errMsg.includes('Goal')) {
      status = 'GOALCHG'
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
    // Diagnostic: check terrain at start position
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

function countLeavesAlongLine (bot, start, goal) {
  let count = 0
  const dist = start.distanceTo(goal)
  const steps = Math.ceil(dist)
  if (steps === 0) return 0
  const dx = (goal.x - start.x) / steps, dz = (goal.z - start.z) / steps
  const checked = new Set()
  for (let i = 0; i <= steps; i++) {
    const x = Math.floor(start.x + dx * i), z = Math.floor(start.z + dz * i)
    for (const [sx, sz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${x + sx},${z + sz}`
      if (checked.has(key)) continue; checked.add(key)
      for (const dy of [0, 1]) {
        const b = bot.blockAt(new Vec3(x + sx, start.y + dy, z + sz))
        if (b && b.name && b.name.includes('leaves')) count++
      }
    }
  }
  return count
}

function findNearestSafeSpot (bot, pos, radius) {
  let best = null, bestDist = Infinity
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++)
      for (let dy = -3; dy <= 3; dy++) {
        const x = pos.x + dx, y = pos.y + dy, z = pos.z + dz
        const below = bot.blockAt(new Vec3(x, y - 1, z))
        const at = bot.blockAt(new Vec3(x, y, z))
        const above = bot.blockAt(new Vec3(x, y + 1, z))
        if (below && below.boundingBox === 'block' && at && at.boundingBox === 'empty' && above && above.boundingBox === 'empty') {
          const d = pos.distanceTo(new Vec3(x, y, z))
          if (d < bestDist) { bestDist = d; best = new Vec3(x, y, z) }
        }
      }
  return best
}

function findForestInfo (bot, center, mcData, radius) {
  const trees = [], found = new Set()
  let leafHeadCount = 0
  const leafPositions = []
  for (let x = -radius; x <= radius; x += 2)
    for (let z = -radius; z <= radius; z += 2)
      for (let y = center.y - 15; y <= center.y + 20; y++) {
        const pos = new Vec3(center.x + x, y, center.z + z)
        const block = bot.blockAt(pos)
        if (!block) continue
        if (block.name.includes('log')) {
          const key = `${pos.x},${pos.z}`
          if (!found.has(key)) {
            found.add(key)
            const gspot = findNearestSafeSpot(bot, new Vec3(pos.x + 1, y, pos.z + 1), 4)
            if (gspot) trees.push(gspot)
            if (trees.length >= 30) return { trees, leafHeadCount, leafPositions }
          }
        }
        if (block.name.includes('leaves')) {
          const b1 = bot.blockAt(new Vec3(pos.x, y - 1, pos.z))
          const b2 = bot.blockAt(new Vec3(pos.x, y - 2, pos.z))
          if (b1 && b1.boundingBox === 'empty' && b2 && b2.boundingBox === 'block') {
            leafHeadCount++; leafPositions.push(pos.clone())
          }
        }
      }
  return { trees, leafHeadCount, leafPositions }
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
    // ORIGINAL BUG: only checks cheaper intermediate
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
  if (orig.dangerDiags > 0 && fixed.dangerDiags === 0) v.push(`FIX: ${orig.dangerDiags} ddiags→0`)
  if (fs.includes(orig.status) && fixed.status === 'PASS') v.push('★ ORIG FAIL, FIXED PASS')
  if (orig.status === 'PASS' && fs.includes(fixed.status)) v.push('✗ REGRESSION')
  if (orig.stuck > 0 && fixed.stuck === 0 && fixed.status === 'PASS') v.push(`STUCK FIX: orig stuck ${orig.stuck}x`)
  return v.join(' | ') || null
}

function printFinalSummary (results) {
  const o = { pass: 0, fail: 0, stuck: 0, nopath: 0, resets: 0, diags: 0, times: [], stucks: [] }
  const f = { pass: 0, fail: 0, stuck: 0, nopath: 0, resets: 0, diags: 0, times: [], stucks: [] }
  let imp = 0, reg = 0, eff = 0
  const failStatuses = ['STUCK', 'SLOW', 'ERR', 'NOPATH']
  // Timing: only compare on routes where both versions PASS
  const bothPassTimes = { orig: [], fixed: [] }
  for (const r of results) {
    r.orig.status === 'PASS' ? o.pass++ : o.fail++
    r.fixed.status === 'PASS' ? f.pass++ : f.fail++
    if (r.orig.status === 'STUCK') o.stuck++; if (r.fixed.status === 'STUCK') f.stuck++
    if (r.orig.status === 'NOPATH') o.nopath++; if (r.fixed.status === 'NOPATH') f.nopath++
    o.resets += r.orig.resets; o.diags += r.orig.dangerDiags
    f.resets += r.fixed.resets; f.diags += r.fixed.dangerDiags
    o.times.push(parseFloat(r.orig.time)); f.times.push(parseFloat(r.fixed.time))
    o.stucks.push(r.orig.stuck); f.stucks.push(r.fixed.stuck)
    if (failStatuses.includes(r.orig.status) && r.fixed.status === 'PASS') imp++
    if (r.orig.status === 'PASS' && failStatuses.includes(r.fixed.status)) reg++
    if (r.orig.dangerDiags > 0 && r.fixed.dangerDiags === 0) eff++
    if (r.orig.status === 'PASS' && r.fixed.status === 'PASS') {
      bothPassTimes.orig.push(parseFloat(r.orig.time))
      bothPassTimes.fixed.push(parseFloat(r.fixed.time))
    }
  }
  const n = results.length
  const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : 'N/A'
  const med = arr => { if (!arr.length) return 'N/A'; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m].toFixed(2) : ((s[m - 1] + s[m]) / 2).toFixed(2) }
  const sum = arr => arr.reduce((a, b) => a + b, 0)

  console.log('\n' + '═'.repeat(66))
  console.log('  FINAL SUMMARY')
  console.log('═'.repeat(66))
  console.log(`  Routes tested: ${n}\n`)
  console.log('  ┌────────────────────┬──────────────┬──────────────┐')
  console.log('  │ Metric             │ ORIGINAL     │ FIXED        │')
  console.log('  ├────────────────────┼──────────────┼──────────────┤')
  console.log(`  │ Passed             │ ${pad(o.pass + '/' + n, 12)} │ ${pad(f.pass + '/' + n, 12)} │`)
  console.log(`  │ Failed             │ ${pad(o.fail, 12)} │ ${pad(f.fail, 12)} │`)
  console.log(`  │ Stuck              │ ${pad(o.stuck, 12)} │ ${pad(f.stuck, 12)} │`)
  console.log(`  │ NoPath             │ ${pad(o.nopath, 12)} │ ${pad(f.nopath, 12)} │`)
  console.log(`  │ Path resets        │ ${pad(o.resets, 12)} │ ${pad(f.resets, 12)} │`)
  console.log(`  │ DANGER DIAGONALS   │ ${pad(o.diags, 12)} │ ${pad(f.diags, 12)} │`)
  console.log('  └────────────────────┴──────────────┴──────────────┘\n')

  // Timing & retry statistics
  console.log('  ┌─── Timing (routes where BOTH pass) ─────────────────────┐')
  if (bothPassTimes.orig.length > 0) {
    console.log(`  │ Routes compared:    ${bothPassTimes.orig.length}`)
    console.log(`  │ Avg time  ORIG:     ${avg(bothPassTimes.orig)}s`)
    console.log(`  │ Avg time  FIXED:    ${avg(bothPassTimes.fixed)}s`)
    console.log(`  │ Med time  ORIG:     ${med(bothPassTimes.orig)}s`)
    console.log(`  │ Med time  FIXED:    ${med(bothPassTimes.fixed)}s`)
    const fasterCount = bothPassTimes.orig.reduce((c, t, i) => t > bothPassTimes.fixed[i] ? c + 1 : c, 0)
    const slowerCount = bothPassTimes.orig.reduce((c, t, i) => t < bothPassTimes.fixed[i] ? c + 1 : c, 0)
    console.log(`  │ FIXED faster on:    ${fasterCount}/${bothPassTimes.orig.length} routes`)
    console.log(`  │ FIXED slower on:    ${slowerCount}/${bothPassTimes.orig.length} routes`)
  } else {
    console.log('  │ No routes where both versions pass')
  }
  console.log('  └─────────────────────────────────────────────────────────┘\n')

  console.log('  ┌─── Retry / Stuck stats (all routes) ────────────────────┐')
  console.log(`  │ Total resets    ORIG: ${o.resets}    FIXED: ${f.resets}`)
  console.log(`  │ Total stucks    ORIG: ${sum(o.stucks)}    FIXED: ${sum(f.stucks)}`)
  console.log(`  │ Avg resets/route ORIG: ${(o.resets / n).toFixed(2)}  FIXED: ${(f.resets / n).toFixed(2)}`)
  console.log('  └─────────────────────────────────────────────────────────┘\n')

  console.log(`  ★ Fix improved (ORIG fail→FIXED pass): ${imp}`)
  console.log(`  ✗ Regressions (ORIG pass→FIXED fail):  ${reg}`)
  console.log(`  ✓ Dangerous diags eliminated:          ${eff}\n`)

  // Key routes
  const key = results.filter(r =>
    (failStatuses.includes(r.orig.status) && r.fixed.status === 'PASS') ||
    (r.orig.status === 'PASS' && failStatuses.includes(r.fixed.status)) ||
    (r.orig.dangerDiags >= 5 && r.fixed.dangerDiags === 0)
  )
  if (key.length > 0) {
    console.log('  Key routes:')
    for (const r of key) {
      const tag = failStatuses.includes(r.orig.status) && r.fixed.status === 'PASS' ? '★' :
        r.orig.status === 'PASS' && failStatuses.includes(r.fixed.status) ? '✗' : '✓'
      console.log(`    ${tag} ${r.desc}: ORIG=${r.orig.status}(${r.orig.time}s,dd=${r.orig.dangerDiags},stuck=${r.orig.stuck},resets=${r.orig.resets}) FIXED=${r.fixed.status}(${r.fixed.time}s,dd=${r.fixed.dangerDiags},stuck=${r.fixed.stuck},resets=${r.fixed.resets})`)
    }
  }

  // Fixed failures detail
  const ff = results.filter(r => r.fixed.status !== 'PASS')
  if (ff.length > 0) {
    console.log('\n  Fixed version failures:')
    for (const r of ff) {
      const alsoOrig = r.orig.status !== 'PASS' ? ' (ORIG also failed)' : ' ✗ REGRESSION'
      console.log(`    ${r.desc}: ${r.fixed.status} ${r.fixed.time}s goalDist=${r.fixed.goalDist}${alsoOrig}`)
    }
  }

  // Per-route detail table with timing
  console.log('\n  ┌─── Per-route timing comparison (both PASS only) ─────────┐')
  const bothPass = results.filter(r => r.orig.status === 'PASS' && r.fixed.status === 'PASS')
  if (bothPass.length > 0) {
    // Show routes with biggest time difference
    const sorted = [...bothPass].sort((a, b) => (parseFloat(b.orig.time) - parseFloat(b.fixed.time)) - (parseFloat(a.orig.time) - parseFloat(a.fixed.time)))
    const top = sorted.slice(0, 10)
    for (const r of top) {
      const diff = (parseFloat(r.orig.time) - parseFloat(r.fixed.time)).toFixed(1)
      const arrow = diff > 0 ? `FIXED ${diff}s faster` : diff < 0 ? `ORIG ${(-diff).toFixed(1)}s faster` : 'same'
      console.log(`  │ ${r.desc}: ORIG=${r.orig.time}s FIXED=${r.fixed.time}s → ${arrow}`)
    }
    if (sorted.length > 10) console.log(`  │ ... and ${sorted.length - 10} more routes`)
  }
  console.log('  └─────────────────────────────────────────────────────────┘')

  console.log('\n' + (imp > 0 && reg === 0 ? '  CONCLUSION: Fix EFFECTIVE — improved routes, zero regressions' :
    imp > reg ? `  CONCLUSION: Net positive — ${imp} improved vs ${reg} regressed` :
    reg > 0 ? `  CONCLUSION: Has regressions — ${reg} routes worse` :
    eff > 0 ? '  CONCLUSION: Fix eliminates dangerous diagonals safely' :
    '  CONCLUSION: No significant difference'))
  console.log('═'.repeat(66))
}

// ════════════════════════════════════════════════
//  VISUALIZATION: Terrain scanning + tracked tests + HTML generation
// ════════════════════════════════════════════════

function scanTerrain (bot, route) {
  const margin = 8
  const minX = Math.min(route.sx, route.gx) - margin
  const maxX = Math.max(route.sx, route.gx) + margin
  const minZ = Math.min(route.sz, route.gz) - margin
  const maxZ = Math.max(route.sz, route.gz) + margin
  const baseY = Math.min(route.sy, route.gy)
  const blocks = {}
  for (let x = minX; x <= maxX; x++)
    for (let z = minZ; z <= maxZ; z++)
      for (let y = baseY - 3; y <= baseY + 10; y++) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (b && b.name !== 'air') {
          if (!blocks[`${x},${z}`]) blocks[`${x},${z}`] = []
          blocks[`${x},${z}`].push({ y, name: b.name, bb: b.boundingBox })
        }
      }
  return { minX, maxX, minZ, maxZ, baseY, blocks }
}

async function runTrackedTest (bot, movements, route, timeout) {
  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(null)
  await sleep(200)

  const posLog = [], pathNodes = []
  let dangerDiags = 0, resets = 0
  const t0 = Date.now()

  const posI = setInterval(() => {
    if (bot.entity) posLog.push({ x: +bot.entity.position.x.toFixed(2), z: +bot.entity.position.z.toFixed(2), y: +bot.entity.position.y.toFixed(2), t: Date.now() - t0 })
  }, 200)

  const pathH = (r) => {
    if (!r.path) return
    for (const node of r.path) pathNodes.push({ x: Math.floor(node.x), z: Math.floor(node.z), y: Math.floor(node.y) })
    for (let i = 1; i < r.path.length; i++) {
      const prev = r.path[i - 1], curr = r.path[i]
      const ddx = Math.round(curr.x - prev.x), ddz = Math.round(curr.z - prev.z)
      if (Math.abs(ddx) === 1 && Math.abs(ddz) === 1) {
        const px = Math.floor(prev.x), py = Math.floor(prev.y), pz = Math.floor(prev.z)
        const ddy = Math.round(curr.y - prev.y), yBase = ddy > 0 ? 1 : 0
        for (const dy of [yBase, yBase + 1]) {
          const h1 = bot.blockAt(new Vec3(px, py + dy, pz + ddz))
          const h2 = bot.blockAt(new Vec3(px + ddx, py + dy, pz))
          if ((h1 && h1.boundingBox === 'block') || (h2 && h2.boundingBox === 'block')) { dangerDiags++; break }
        }
      }
    }
  }
  const resetH = () => { resets++ }
  bot.on('path_update', pathH)
  bot.on('path_reset', resetH)

  let status = 'PASS', errMsg = ''
  try {
    await Promise.race([
      bot.pathfinder.goto(new GoalNear(route.gx, route.gy, route.gz, 2)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeout))
    ])
  } catch (err) {
    errMsg = err.message || String(err)
    if (errMsg === 'Timeout') {
      const recent = posLog.slice(-10)
      let maxD = 0
      if (recent.length >= 6) {
        for (let i = 0; i < recent.length; i++)
          for (let j = i + 1; j < recent.length; j++)
            maxD = Math.max(maxD, Math.hypot(recent[i].x - recent[j].x, recent[i].z - recent[j].z))
      }
      status = maxD < 2 ? 'STUCK' : 'SLOW'
    } else if (errMsg.includes('NoPath') || errMsg.includes('noPath') || errMsg.includes('No path')) {
      status = 'NOPATH'
    } else { status = 'ERR' }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  clearInterval(posI)
  bot.removeListener('path_update', pathH)
  bot.removeListener('path_reset', resetH)
  bot.pathfinder.setGoal(null)
  await sleep(200)
  if (bot.entity) posLog.push({ x: +bot.entity.position.x.toFixed(2), z: +bot.entity.position.z.toFixed(2), y: +bot.entity.position.y.toFixed(2), t: Date.now() - t0 })

  const seen = new Set()
  const uniqueNodes = pathNodes.filter(n => { const k = `${n.x},${n.y},${n.z}`; if (seen.has(k)) return false; seen.add(k); return true })

  return { status, time: parseFloat(elapsed), dangerDiags, resets, posLog, pathNodes: uniqueNodes, errMsg }
}

function generateVizHTML (vizData) {
  const dataJSON = JSON.stringify(vizData)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pathfinder Fix — Path Visualization</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;padding:20px}
h1{color:#58a6ff;font-size:24px;margin-bottom:8px}
.sub{color:#8b949e;font-size:14px;margin-bottom:30px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:24px}
.rh{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px}
.rn{font-size:18px;font-weight:600;color:#f0f6fc}
.lb{background:#238636;color:#fff;padding:2px 10px;border-radius:12px;font-size:13px}
.sr{display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap}
.sb{padding:12px 20px;border-radius:8px;min-width:200px;flex:1}
.sb.o{background:#1c1210;border:1px solid #6e3630}
.sb.f{background:#0d1f0d;border:1px solid #2ea043}
.sb .l{font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.sb.o .l{color:#f85149}
.sb.f .l{color:#3fb950}
.sb .v{font-size:20px;font-weight:700}
.sb .d{font-size:12px;color:#8b949e;margin-top:4px}
.s-PASS{color:#3fb950}.s-STUCK{color:#f85149}.s-ERR{color:#f85149}.s-NOPATH{color:#d29922}.s-SLOW{color:#d29922}
.vd{padding:8px 16px;border-radius:8px;font-weight:600;font-size:14px;margin-bottom:16px;display:inline-block}
.vd.imp{background:#0d2818;color:#3fb950;border:1px solid #238636}
.vd.reg{background:#2d1210;color:#f85149;border:1px solid #6e3630}
.vd.sam{background:#1c1e24;color:#8b949e;border:1px solid #30363d}
.maps{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}
.mc{text-align:center}
.ml{font-size:13px;font-weight:600;margin-bottom:8px}
.ml.o{color:#f85149}.ml.f{color:#3fb950}
canvas{border:1px solid #30363d;border-radius:8px;image-rendering:pixelated}
.lg{display:flex;gap:16px;flex-wrap:wrap;margin-top:16px;justify-content:center}
.li{display:flex;align-items:center;gap:6px;font-size:12px;color:#8b949e}
.lc{width:14px;height:14px;border-radius:3px;border:1px solid #30363d}
.sc{background:#161b22;border:1px solid #58a6ff;border-radius:12px;padding:24px;margin-bottom:30px}
.sc h2{color:#58a6ff;font-size:18px;margin-bottom:12px}
.sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.ss{text-align:center;padding:12px;background:#0d1117;border-radius:8px}
.ss .n{font-size:28px;font-weight:700}
.ss .t{font-size:11px;color:#8b949e;margin-top:4px}
</style>
</head>
<body>
<h1>Pathfinder Fix — Route Visualization</h1>
<p class="sub">ORIG = upstream (old diagonal, no leaf break) &nbsp; vs &nbsp; FIXED = patched (both intermediates + leaf break)</p>
<div id="summary"></div>
<div id="routes"></div>
<script>
const DATA=${dataJSON};
const COLS={grass_block:'#3a7d22',dirt:'#8b6914',stone:'#808080',coarse_dirt:'#6b5a3e',sand:'#e8d5a3',gravel:'#9e9e9e',water:'#3366cc',snow:'#f0f0f0',snow_block:'#e8e8e8',ice:'#a0d0f0',oak_log:'#6b4f2e',spruce_log:'#3d2e1a',birch_log:'#d4cdb8',dark_oak_log:'#3d2813',oak_leaves:'#4a8c2a',spruce_leaves:'#3a6b3a',birch_leaves:'#5a9a3a',dark_oak_leaves:'#3a7a2a',podzol:'#6b5a3e',moss_block:'#4a7a2a'};
function gc(n){if(COLS[n])return COLS[n];if(n.includes('leaves'))return'#4a8c2a';if(n.includes('log')||n.includes('wood'))return'#6b4f2e';if(n.includes('stone')||n.includes('ore'))return'#808080';if(n.includes('dirt')||n.includes('mud'))return'#8b6914';if(n.includes('grass'))return'#3a7d22';if(n.includes('sand'))return'#e8d5a3';if(n.includes('snow'))return'#f0f0f0';if(n.includes('water'))return'#3366cc';return'#5a7d4a'}
function isL(n){return n&&n.includes('leaves')}
function isG(n){return n&&(n.includes('log')||n.includes('wood'))}
function renderSummary(){
  const el=document.getElementById('summary');
  let imp=0,reg=0,sam=0;const fs=['STUCK','SLOW','ERR','NOPATH'];
  for(const r of DATA){if(fs.includes(r.orig.status)&&r.fixed.status==='PASS')imp++;else if(r.orig.status==='PASS'&&fs.includes(r.fixed.status))reg++;else sam++}
  el.innerHTML='<div class="sc"><h2>Overview — '+DATA.length+' Routes Visualized</h2><div class="sg">'
    +'<div class="ss"><div class="n" style="color:#3fb950">'+imp+'</div><div class="t">ORIG Fail → FIXED Pass</div></div>'
    +'<div class="ss"><div class="n" style="color:#f85149">'+reg+'</div><div class="t">Regressions</div></div>'
    +'<div class="ss"><div class="n" style="color:#8b949e">'+sam+'</div><div class="t">Same Result</div></div>'
    +'<div class="ss"><div class="n" style="color:#d29922">'+DATA.reduce((s,r)=>s+r.orig.dangerDiags,0)+'</div><div class="t">ORIG Danger Diags</div></div>'
    +'<div class="ss"><div class="n" style="color:#3fb950">'+DATA.reduce((s,r)=>s+r.fixed.dangerDiags,0)+'</div><div class="t">FIXED Danger Diags</div></div>'
    +'</div></div>';
}
function renderRoute(rd,idx){
  const c=document.getElementById('routes');const card=document.createElement('div');card.className='card';
  const fs=['STUCK','SLOW','ERR','NOPATH'];
  const isImp=fs.includes(rd.orig.status)&&rd.fixed.status==='PASS';
  const isReg=rd.orig.status==='PASS'&&fs.includes(rd.fixed.status);
  const vc=isImp?'imp':isReg?'reg':'sam';
  const vt=isImp?'★ ORIG FAIL → FIXED PASS':isReg?'✗ REGRESSION':'Both '+(rd.orig.status==='PASS'?'PASS':'FAIL');
  card.innerHTML='<div class="rh"><span class="rn">#'+(idx+1)+' '+rd.name+'</span><span class="lb">'+rd.leafCount+' leaves</span></div>'
    +'<div class="vd '+vc+'">'+vt+'</div>'
    +'<div class="sr"><div class="sb o"><div class="l">Original (upstream)</div><div class="v s-'+rd.orig.status+'">'+rd.orig.status+' '+rd.orig.time+'s</div>'
    +'<div class="d">Danger diags: '+rd.orig.dangerDiags+' | Resets: '+rd.orig.resets+(rd.orig.errMsg?' | '+rd.orig.errMsg:'')+'</div></div>'
    +'<div class="sb f"><div class="l">Fixed (patched)</div><div class="v s-'+rd.fixed.status+'">'+rd.fixed.status+' '+rd.fixed.time+'s</div>'
    +'<div class="d">Danger diags: '+rd.fixed.dangerDiags+' | Resets: '+rd.fixed.resets+(rd.fixed.errMsg?' | '+rd.fixed.errMsg:'')+'</div></div></div>'
    +'<div class="maps"><div class="mc"><div class="ml o">ORIGINAL path</div><canvas id="mo-'+idx+'"></canvas></div>'
    +'<div class="mc"><div class="ml f">FIXED path</div><canvas id="mf-'+idx+'"></canvas></div></div>'
    +'<div class="lg">'
    +'<div class="li"><div class="lc" style="background:#3a7d22"></div>Ground</div>'
    +'<div class="li"><div class="lc" style="background:#2d5a1e"></div>Leaves (head)</div>'
    +'<div class="li"><div class="lc" style="background:#6b4f2e"></div>Log</div>'
    +'<div class="li"><div class="lc" style="background:#ffcc00"></div>A* path</div>'
    +'<div class="li"><div class="lc" style="background:rgba(255,100,100,0.9)"></div>Bot trail (ORIG)</div>'
    +'<div class="li"><div class="lc" style="background:rgba(100,255,150,0.9)"></div>Bot trail (FIXED)</div>'
    +'<div class="li"><div class="lc" style="background:#00ff00"></div>Start</div>'
    +'<div class="li"><div class="lc" style="background:#ff3333"></div>Goal</div>'
    +'</div>';
  c.appendChild(card);
  requestAnimationFrame(()=>{drawMap(rd,idx,'orig','mo-');drawMap(rd,idx,'fixed','mf-')});
}
function drawMap(rd,idx,ver,pre){
  const cv=document.getElementById(pre+idx);if(!cv)return;
  const t=rd.terrain,S=12;
  const w=t.maxX-t.minX+1,h=t.maxZ-t.minZ+1;
  cv.width=w*S;cv.height=h*S;
  cv.style.width=Math.min(w*S,500)+'px';cv.style.height=Math.min(h*S,500)+'px';
  const ctx=cv.getContext('2d');
  ctx.fillStyle='#1a1a2e';ctx.fillRect(0,0,cv.width,cv.height);
  for(const[key,blks]of Object.entries(t.blocks)){
    const[bx,bz]=key.split(',').map(Number);const px=(bx-t.minX)*S,py=(bz-t.minZ)*S;
    let gnd=null,lf=null,lg=null;const so=blks.sort((a,b)=>a.y-b.y);
    for(const b of so){if(isG(b.name))lg=b;if(isL(b.name)&&b.y>=t.baseY&&b.y<=t.baseY+2)lf=b;if(b.bb==='block'&&!isL(b.name)&&b.y<=t.baseY+1)gnd=b}
    if(gnd){ctx.fillStyle=gc(gnd.name);ctx.fillRect(px,py,S,S)}
    if(lf){ctx.fillStyle='rgba(30,100,30,0.7)';ctx.fillRect(px,py,S,S);ctx.strokeStyle='rgba(50,140,50,0.5)';ctx.lineWidth=.5;ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(px+S,py+S);ctx.moveTo(px+S,py);ctx.lineTo(px,py+S);ctx.stroke()}
    if(lg){ctx.fillStyle='#6b4f2e';const m=S*.2;ctx.fillRect(px+m,py+m,S-2*m,S-2*m)}
  }
  ctx.strokeStyle='rgba(255,255,255,0.05)';ctx.lineWidth=.5;
  for(let x=0;x<=w;x++){ctx.beginPath();ctx.moveTo(x*S,0);ctx.lineTo(x*S,h*S);ctx.stroke()}
  for(let z=0;z<=h;z++){ctx.beginPath();ctx.moveTo(0,z*S);ctx.lineTo(w*S,z*S);ctx.stroke()}
  const vd=rd[ver];
  if(vd.pathNodes&&vd.pathNodes.length>0){ctx.fillStyle='rgba(255,204,0,0.4)';for(const n of vd.pathNodes){ctx.fillRect((n.x-t.minX)*S+1,(n.z-t.minZ)*S+1,S-2,S-2)}}
  if(vd.posLog&&vd.posLog.length>1){
    const tc=ver==='orig'?'rgba(255,100,100,0.9)':'rgba(100,255,150,0.9)';
    ctx.strokeStyle=tc;ctx.lineWidth=2.5;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();
    ctx.moveTo((vd.posLog[0].x-t.minX)*S+S/2,(vd.posLog[0].z-t.minZ)*S+S/2);
    for(let i=1;i<vd.posLog.length;i++)ctx.lineTo((vd.posLog[i].x-t.minX)*S+S/2,(vd.posLog[i].z-t.minZ)*S+S/2);
    ctx.stroke();
    if(vd.status==='STUCK'||(vd.status==='ERR'&&vd.time>5)){
      const last=vd.posLog[vd.posLog.length-1];const lx=(last.x-t.minX)*S+S/2,lz=(last.z-t.minZ)*S+S/2;
      for(let r=3;r>=1;r--){ctx.beginPath();ctx.arc(lx,lz,S*r*.8,0,Math.PI*2);ctx.fillStyle='rgba(255,0,0,'+(0.15/r)+')';ctx.fill()}
      ctx.beginPath();ctx.arc(lx,lz,5,0,Math.PI*2);ctx.fillStyle='#ff0000';ctx.fill();
      ctx.font='bold 10px sans-serif';ctx.fillStyle='#ff4444';ctx.fillText(vd.status,lx+8,lz+4);
    }
  }
  const sx=(rd.start.x-t.minX)*S+S/2,sz=(rd.start.z-t.minZ)*S+S/2;
  ctx.beginPath();ctx.arc(sx,sz,6,0,Math.PI*2);ctx.fillStyle='#00ff00';ctx.fill();ctx.strokeStyle='#003300';ctx.lineWidth=2;ctx.stroke();
  ctx.font='bold 10px sans-serif';ctx.fillStyle='#00ff00';ctx.fillText('S',sx+8,sz+4);
  const gx=(rd.goal.x-t.minX)*S+S/2,gz=(rd.goal.z-t.minZ)*S+S/2;
  ctx.beginPath();ctx.arc(gx,gz,6,0,Math.PI*2);ctx.fillStyle='#ff3333';ctx.fill();ctx.strokeStyle='#330000';ctx.lineWidth=2;ctx.stroke();
  ctx.font='bold 10px sans-serif';ctx.fillStyle='#ff3333';ctx.fillText('G',gx+8,gz+4);
}
renderSummary();DATA.forEach((r,i)=>renderRoute(r,i));
</script>
</body>
</html>`;
}

function pad (v, n) { return String(v).padEnd(n) }
function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
bot.on('error', (err) => console.error('[Bot Error]', err.message))
bot.on('kicked', (reason) => console.log('[Kicked]', reason))
