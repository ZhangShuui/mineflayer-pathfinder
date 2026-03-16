/**
 * 3D Visualization: Guaranteed ORIG FAIL → FIXED PASS scenarios
 * Strategy:
 *   1. "Canopy escape" routes — bot on tree canopy → ground. ORIG can't break leaves, FIXED can.
 *   2. "Dense diagonal" routes — through heavy leaf canopy. Shows path differences.
 * Generates viz-3d.html with THREE.js 3D rendering.
 */

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('./index')
const { GoalNear } = goals
const Vec3 = require('vec3')
const Move = require('./lib/move')
const fs = require('fs')

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'PathBot', version: '1.20.4'
})
bot.loadPlugin(pathfinder)

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

bot.once('spawn', async () => {
  console.log('[Bot] Spawned')
  await sleep(5000)
  const mcData = require('minecraft-data')(bot.version)

  bot.chat('/tp @s 800 100 0')
  await sleep(4000)
  const center = bot.entity.position.floored()
  console.log('Forest center:', center.toString())

  // ══ PHASE 1: Find positions TRAPPED inside canopy (guaranteed ORIG FAIL) ══
  // Strategy: find air pockets inside dense leaf canopy where the bot is
  // surrounded by leaves on all sides — can't move without breaking them.
  console.log('\nScanning for trapped-in-canopy positions...')
  const trappedPositions = []
  for (let x = -50; x <= 50; x += 1)
    for (let z = -50; z <= 50; z += 1)
      for (let y = center.y + 1; y <= center.y + 20; y++) {
        const bx = center.x + x, bz = center.z + z
        const below = bot.blockAt(new Vec3(bx, y - 1, bz))
        const at = bot.blockAt(new Vec3(bx, y, bz))
        const above = bot.blockAt(new Vec3(bx, y + 1, bz))
        if (!below || !at || !above) continue
        // Need: solid below (any type), air at body+head
        if (below.boundingBox !== 'block') continue
        if (at.boundingBox !== 'empty' || above.boundingBox !== 'empty') continue

        // Count how many cardinal directions are blocked by leaves at body or head level
        let blockedDirs = 0, leafWalls = 0
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const b1 = bot.blockAt(new Vec3(bx + dx, y, bz + dz))
          const b2 = bot.blockAt(new Vec3(bx + dx, y + 1, bz + dz))
          const blocked = (b1 && b1.boundingBox === 'block') || (b2 && b2.boundingBox === 'block')
          if (blocked) blockedDirs++
          if ((b1 && b1.name.includes('leaves')) || (b2 && b2.name.includes('leaves'))) leafWalls++
        }

        // Position is interesting if most directions have leaves
        if (leafWalls >= 3) {
          // Find ground distance
          let groundY = y - 1
          while (groundY > center.y - 10) {
            const gb = bot.blockAt(new Vec3(bx, groundY, bz))
            if (gb && gb.boundingBox === 'block' && !gb.name.includes('leaves')) break
            groundY--
          }
          trappedPositions.push({ x: bx, y, z: bz, leafWalls, blockedDirs, groundY, height: y - groundY })
        }
      }

  // Sort: most blocked first, then highest
  trappedPositions.sort((a, b) => (b.leafWalls + b.blockedDirs) - (a.leafWalls + a.blockedDirs) || b.height - a.height)
  console.log(`Found ${trappedPositions.length} potential trapped positions (3+ leaf walls)`)

  // De-dup and find goals
  const candidateRoutes = []
  for (const cp of trappedPositions) {
    if (candidateRoutes.some(u => Math.hypot(u.sx - cp.x, u.sz - cp.z) < 5)) continue
    // Find ground goal within 15 blocks
    let goal = null
    for (let dx = -10; dx <= 10; dx++)
      for (let dz = -10; dz <= 10; dz++)
        for (let dy = -15; dy <= 0; dy++) {
          const gx = cp.x + dx, gy = cp.y + dy, gz = cp.z + dz
          const gb = bot.blockAt(new Vec3(gx, gy - 1, gz))
          const ga = bot.blockAt(new Vec3(gx, gy, gz))
          const gab = bot.blockAt(new Vec3(gx, gy + 1, gz))
          if (gb && gb.boundingBox === 'block' && !gb.name.includes('leaves') &&
              ga && ga.boundingBox === 'empty' && gab && gab.boundingBox === 'empty') {
            const d = Math.hypot(dx, dz) + Math.abs(dy)
            if (!goal || d < goal.dist) goal = { x: gx, y: gy, z: gz, dist: d }
          }
        }
    if (goal) {
      candidateRoutes.push({
        sx: cp.x, sy: cp.y, sz: cp.z,
        gx: goal.x, gy: goal.y, gz: goal.z,
        desc: `Trapped in canopy (${cp.leafWalls} leaf walls, ${cp.height}m up)`
      })
    }
    if (candidateRoutes.length >= 25) break
  }
  console.log(`Generated ${candidateRoutes.length} candidate trapped routes`)

  // Pre-screen: quick ORIG test to find GUARANTEED failures
  console.log('Pre-screening with ORIG pathfinder...')
  const confirmedCanopy = []
  for (let i = 0; i < candidateRoutes.length; i++) {
    const r = candidateRoutes[i]
    const testMov = new Movements(bot)
    testMov.canDig = false; testMov.allowSprinting = true; testMov.allowBreakLeaves = false
    patchOriginalDiagonal(testMov)
    await safeTP(bot, r.sx, r.sy, r.sz)
    bot.pathfinder.setMovements(testMov)
    bot.pathfinder.setGoal(null)
    await sleep(200)
    let failed = false
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(r.gx, r.gy, r.gz, 2)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 8000))
      ])
    } catch (e) { failed = true }
    bot.pathfinder.setGoal(null)
    await sleep(200)
    const tag = failed ? '✗ ORIG FAILS' : '✓ ORIG passes'
    console.log(`  [${i + 1}/${candidateRoutes.length}] ${r.desc} → ${tag}`)
    if (failed) confirmedCanopy.push(r)
    if (confirmedCanopy.length >= 4) break
  }
  console.log(`Confirmed ${confirmedCanopy.length} routes where ORIG fails\n`)

  // ══ PHASE 2: Find dense diagonal routes (high dd count) ══
  console.log('\nFinding dense diagonal routes...')
  const forest = findForestInfo(bot, center, mcData, 50)
  const diagRoutes = generateRoutes(bot, forest).slice(0, 10) // top 10 by leaf density
  console.log(`Top diagonal routes: ${diagRoutes.length}`)

  // ══ PHASE 3: Run all routes with tracking ══
  const allRoutes = [
    ...confirmedCanopy.map(r => ({ ...r, type: 'canopy' })),
    ...diagRoutes.slice(0, Math.max(2, 6 - confirmedCanopy.length)).map(r => ({ ...r, type: 'diagonal' }))
  ]

  console.log(`\nRunning ${allRoutes.length} routes with tracking...\n`)
  const vizData = []

  for (let i = 0; i < allRoutes.length; i++) {
    const r = allRoutes[i]
    console.log(`━━━ [${i + 1}/${allRoutes.length}] ${r.desc} (${r.type}) ━━━`)

    const terrain = scanTerrain(bot, r)

    // ORIG
    console.log('  ORIG...')
    const origMov = new Movements(bot)
    origMov.canDig = false
    origMov.allowSprinting = true
    origMov.allowBreakLeaves = false
    patchOriginalDiagonal(origMov)
    await safeTP(bot, r.sx, r.sy, r.sz)
    const origResult = await runTracked(bot, origMov, r, 25000)
    console.log(`    ${origResult.status} ${origResult.time}s dd=${origResult.dangerDiags}`)

    // FIXED
    console.log('  FIXED...')
    const fixedMov = new Movements(bot)
    fixedMov.canDig = false
    fixedMov.allowSprinting = true
    await safeTP(bot, r.sx, r.sy, r.sz)
    const fixedResult = await runTracked(bot, fixedMov, r, 25000)
    console.log(`    ${fixedResult.status} ${fixedResult.time}s dd=${fixedResult.dangerDiags}`)

    const failS = ['STUCK', 'SLOW', 'ERR', 'NOPATH']
    const tag = failS.includes(origResult.status) && fixedResult.status === 'PASS' ? ' ★ IMPROVED' :
      origResult.status === 'PASS' && failS.includes(fixedResult.status) ? ' ✗ REGRESSION' : ''
    if (tag) console.log(`    ${tag}`)

    vizData.push({
      name: r.desc, type: r.type, leafCount: r.lv || 0,
      start: { x: r.sx, y: r.sy, z: r.sz },
      goal: { x: r.gx, y: r.gy, z: r.gz },
      terrain, orig: origResult, fixed: fixedResult
    })
    console.log()
  }

  const html = generateHTML(vizData)
  fs.writeFileSync('viz-3d.html', html)
  console.log('3D visualization saved to viz-3d.html')
  bot.quit(); await sleep(500); process.exit(0)
})

// ═══════════════ Helpers ═══════════════

async function safeTP (bot, x, y, z) {
  bot.pathfinder.setGoal(null)
  await sleep(500)
  bot.chat(`/tp @s ${x + 0.5} 300 ${z + 0.5}`)
  await sleep(800)
  bot.chat(`/tp @s ${x + 0.5} ${y} ${z + 0.5}`)
  await sleep(1500)
  const pos = bot.entity.position
  if (Math.hypot(pos.x - (x + 0.5), pos.z - (z + 0.5)) > 3) {
    bot.chat(`/tp @s ${x + 0.5} 300 ${z + 0.5}`)
    await sleep(800)
    bot.chat(`/tp @s ${x + 0.5} ${y} ${z + 0.5}`)
    await sleep(1500)
  }
}

function scanTerrain (bot, route) {
  const margin = 6
  const minX = Math.min(route.sx, route.gx) - margin
  const maxX = Math.max(route.sx, route.gx) + margin
  const minZ = Math.min(route.sz, route.gz) - margin
  const maxZ = Math.max(route.sz, route.gz) + margin
  const minY = Math.min(route.sy, route.gy) - 4
  const maxY = Math.max(route.sy, route.gy) + 6
  const blocks = []
  for (let x = minX; x <= maxX; x++)
    for (let z = minZ; z <= maxZ; z++)
      for (let y = minY; y <= maxY; y++) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (b && b.name !== 'air' && b.name !== 'cave_air') {
          blocks.push({ x, y, z, n: b.name, s: b.boundingBox === 'block' ? 1 : 0 })
        }
      }
  return { minX, maxX, minZ, maxZ, minY, maxY, blocks }
}

async function runTracked (bot, movements, route, timeout) {
  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(null)
  await sleep(200)

  const posLog = [], pathNodes = []
  let dangerDiags = 0, resets = 0
  const t0 = Date.now()

  const posI = setInterval(() => {
    if (bot.entity) posLog.push([+bot.entity.position.x.toFixed(2), +bot.entity.position.y.toFixed(2), +bot.entity.position.z.toFixed(2), Date.now() - t0])
  }, 150)

  const pathH = (r) => {
    if (!r.path) return
    for (const node of r.path) pathNodes.push([Math.floor(node.x), Math.floor(node.y), Math.floor(node.z)])
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
      for (let i = 0; i < recent.length; i++)
        for (let j = i + 1; j < recent.length; j++)
          maxD = Math.max(maxD, Math.hypot(recent[i][0] - recent[j][0], recent[i][2] - recent[j][2]))
      status = maxD < 2 ? 'STUCK' : 'SLOW'
    } else if (errMsg.includes('NoPath') || errMsg.includes('noPath') || errMsg.includes('No path')) {
      status = 'NOPATH'
    } else if (errMsg.includes('Goal')) { status = 'GOALCHG' }
    else { status = 'ERR' }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  clearInterval(posI)
  bot.removeListener('path_update', pathH)
  bot.removeListener('path_reset', resetH)
  bot.pathfinder.setGoal(null)
  await sleep(200)
  if (bot.entity) posLog.push([+bot.entity.position.x.toFixed(2), +bot.entity.position.y.toFixed(2), +bot.entity.position.z.toFixed(2), Date.now() - t0])

  const seen = new Set()
  const uNodes = pathNodes.filter(n => { const k = n.join(','); if (seen.has(k)) return false; seen.add(k); return true })

  return { status, time: parseFloat(elapsed), dangerDiags, resets, posLog, pathNodes: uNodes, errMsg }
}

function findForestInfo (bot, center, mcData, radius) {
  const trees = [], found = new Set(); let leafHeadCount = 0; const leafPositions = []
  for (let x = -radius; x <= radius; x += 2)
    for (let z = -radius; z <= radius; z += 2)
      for (let y = center.y - 15; y <= center.y + 20; y++) {
        const pos = new Vec3(center.x + x, y, center.z + z)
        const block = bot.blockAt(pos)
        if (!block) continue
        if (block.name.includes('log')) {
          const key = `${pos.x},${pos.z}`
          if (!found.has(key)) { found.add(key); const g = findSafe(bot, new Vec3(pos.x + 1, y, pos.z + 1), 4); if (g) trees.push(g); if (trees.length >= 30) return { trees, leafHeadCount, leafPositions } }
        }
        if (block.name.includes('leaves')) {
          const b1 = bot.blockAt(new Vec3(pos.x, y - 1, pos.z)), b2 = bot.blockAt(new Vec3(pos.x, y - 2, pos.z))
          if (b1 && b1.boundingBox === 'empty' && b2 && b2.boundingBox === 'block') { leafHeadCount++; leafPositions.push(pos.clone()) }
        }
      }
  return { trees, leafHeadCount, leafPositions }
}

function findSafe (bot, pos, radius) {
  let best = null, bestDist = Infinity
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++)
      for (let dy = -3; dy <= 3; dy++) {
        const x = pos.x + dx, y = pos.y + dy, z = pos.z + dz
        const below = bot.blockAt(new Vec3(x, y - 1, z)), at = bot.blockAt(new Vec3(x, y, z)), above = bot.blockAt(new Vec3(x, y + 1, z))
        if (below && below.boundingBox === 'block' && at && at.boundingBox === 'empty' && above && above.boundingBox === 'empty') {
          const d = pos.distanceTo(new Vec3(x, y, z))
          if (d < bestDist) { bestDist = d; best = new Vec3(x, y, z) }
        }
      }
  return best
}

function countLeaves (bot, start, goal) {
  let count = 0; const dist = start.distanceTo(goal), steps = Math.ceil(dist)
  if (steps === 0) return 0
  const dx = (goal.x - start.x) / steps, dz = (goal.z - start.z) / steps, checked = new Set()
  for (let i = 0; i <= steps; i++) {
    const x = Math.floor(start.x + dx * i), z = Math.floor(start.z + dz * i)
    for (const [sx, sz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${x + sx},${z + sz}`
      if (checked.has(key)) continue; checked.add(key)
      for (const dy of [0, 1]) { const b = bot.blockAt(new Vec3(x + sx, start.y + dy, z + sz)); if (b && b.name.includes('leaves')) count++ }
    }
  }
  return count
}

function generateRoutes (bot, forest) {
  const { trees, leafPositions } = forest; const routes = []
  for (let i = 0; i < trees.length; i++)
    for (let j = i + 1; j < trees.length; j++) {
      const dist = trees[i].distanceTo(trees[j]); if (dist < 3 || dist > 30) continue
      const s = findSafe(bot, trees[i], 3), g = findSafe(bot, trees[j], 3)
      if (!s || !g || s.distanceTo(g) < 3) continue
      const lv = countLeaves(bot, s, g)
      if (lv >= 1) routes.push({ sx: s.x, sy: s.y, sz: s.z, gx: g.x, gy: g.y, gz: g.z, lv, desc: `T${i}→T${j} (${dist.toFixed(0)}m,${lv}lv)` })
    }
  for (let i = 0; i < Math.min(leafPositions.length, 25); i++)
    for (let j = i + 1; j < Math.min(leafPositions.length, 25); j++) {
      const dist = leafPositions[i].distanceTo(leafPositions[j]); if (dist < 4 || dist > 20) continue
      const s = findSafe(bot, leafPositions[i].offset(0, -1, 0), 3), g = findSafe(bot, leafPositions[j].offset(0, -1, 0), 3)
      if (!s || !g || s.distanceTo(g) < 3) continue
      const lv = countLeaves(bot, s, g)
      if (lv >= 2) routes.push({ sx: s.x, sy: s.y, sz: s.z, gx: g.x, gy: g.y, gz: g.z, lv, desc: `L${i}→L${j} (${dist.toFixed(0)}m,${lv}lv)` })
    }
  const seen = new Set()
  return routes.filter(r => { const k = `${r.sx},${r.sy},${r.sz}-${r.gx},${r.gy},${r.gz}`; if (seen.has(k)) return false; seen.add(k); return true }).sort((a, b) => b.lv - a.lv)
}

function patchOriginalDiagonal (m) {
  m.getMoveDiagonal = function (node, dir, neighbors) {
    let cost = Math.SQRT2; const toBreak = []
    const blockC = this.getBlock(node, dir.x, 0, dir.z); const y = blockC.physical ? 1 : 0
    const block0 = this.getBlock(node, 0, -1, 0)
    let cost1 = 0; const toBreak1 = []
    cost1 += this.safeOrBreak(this.getBlock(node, 0, y + 1, dir.z), toBreak1)
    cost1 += this.safeOrBreak(this.getBlock(node, 0, y, dir.z), toBreak1)
    const bD1 = this.getBlock(node, 0, y - 1, dir.z)
    if (bD1.height - block0.height > 1.2) cost1 += this.safeOrBreak(bD1, toBreak1)
    let cost2 = 0; const toBreak2 = []
    cost2 += this.safeOrBreak(this.getBlock(node, dir.x, y + 1, 0), toBreak2)
    cost2 += this.safeOrBreak(this.getBlock(node, dir.x, y, 0), toBreak2)
    const bD2 = this.getBlock(node, dir.x, y - 1, 0)
    if (bD2.height - block0.height > 1.2) cost2 += this.safeOrBreak(bD2, toBreak2)
    if (cost1 < cost2) { cost += cost1; toBreak.push(...toBreak1) } else { cost += cost2; toBreak.push(...toBreak2) }
    if (cost > 100) return
    cost += this.safeOrBreak(this.getBlock(node, dir.x, y, dir.z), toBreak); if (cost > 100) return
    cost += this.safeOrBreak(this.getBlock(node, dir.x, y + 1, dir.z), toBreak); if (cost > 100) return
    if (this.getBlock(node, 0, 0, 0).liquid) cost += this.liquidCost
    const blockD = this.getBlock(node, dir.x, -1, dir.z)
    if (y === 1) { if (blockC.height - block0.height > 1.2) return; cost += this.safeOrBreak(this.getBlock(node, 0, 2, 0), toBreak); if (cost > 100) return; cost += 1; neighbors.push(new Move(blockC.position.x, blockC.position.y + 1, blockC.position.z, node.remainingBlocks, cost, toBreak)) }
    else if (blockD.physical || blockC.liquid) { neighbors.push(new Move(blockC.position.x, blockC.position.y, blockC.position.z, node.remainingBlocks, cost, toBreak)) }
    else if (this.getBlock(node, dir.x, -2, dir.z).physical || blockD.liquid) { if (!blockD.safe) return; cost += this.getNumEntitiesAt(blockC.position, 0, -1, 0) * this.entityCost; neighbors.push(new Move(blockC.position.x, blockC.position.y - 1, blockC.position.z, node.remainingBlocks, cost, toBreak)) }
  }
}

// ═══════════════ HTML GENERATION ═══════════════

function generateHTML (vizData) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Pathfinder Fix — 3D Visualization</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden}
#ui{position:fixed;top:0;left:0;right:0;z-index:10;padding:12px 20px;background:rgba(13,17,23,0.95);border-bottom:1px solid #30363d}
h1{font-size:18px;color:#58a6ff;display:inline}
.tabs{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.tab{padding:6px 14px;border-radius:6px;border:1px solid #30363d;background:#161b22;color:#8b949e;cursor:pointer;font-size:13px;transition:all .2s}
.tab:hover{border-color:#58a6ff;color:#c9d1d9}
.tab.active{background:#1f6feb;border-color:#1f6feb;color:#fff}
.tab.improved{border-color:#238636}
.tab.improved.active{background:#238636}
.tab.regression{border-color:#6e3630}
#info{position:fixed;bottom:20px;left:20px;z-index:10;background:rgba(22,27,34,0.95);border:1px solid #30363d;border-radius:12px;padding:16px 20px;min-width:320px;max-width:420px}
#info h2{font-size:16px;color:#f0f6fc;margin-bottom:10px}
.row{display:flex;gap:12px;margin-bottom:8px}
.box{flex:1;padding:8px 12px;border-radius:8px;font-size:13px}
.box.o{background:#1c1210;border:1px solid #6e3630}
.box.f{background:#0d1f0d;border:1px solid #2ea043}
.box .lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px}
.box.o .lbl{color:#f85149}
.box.f .lbl{color:#3fb950}
.box .val{font-size:18px;font-weight:700}
.s-PASS{color:#3fb950}.s-STUCK,.s-ERR{color:#f85149}.s-NOPATH,.s-SLOW{color:#d29922}
.verdict{margin-top:8px;padding:6px 12px;border-radius:6px;font-weight:600;font-size:13px;text-align:center}
.verdict.imp{background:#0d2818;color:#3fb950;border:1px solid #238636}
.verdict.reg{background:#2d1210;color:#f85149;border:1px solid #6e3630}
.verdict.sam{background:#1c1e24;color:#8b949e;border:1px solid #30363d}
#legend{position:fixed;bottom:20px;right:20px;z-index:10;background:rgba(22,27,34,0.95);border:1px solid #30363d;border-radius:12px;padding:14px 18px;font-size:12px}
#legend div{display:flex;align-items:center;gap:8px;margin-bottom:4px}
#legend span{display:inline-block;width:16px;height:16px;border-radius:3px}
#canvas{display:block}
.toggle{position:fixed;top:80px;right:20px;z-index:10;display:flex;flex-direction:column;gap:6px}
.toggle label{display:flex;align-items:center;gap:6px;font-size:12px;color:#8b949e;cursor:pointer}
.toggle input{accent-color:#58a6ff}
</style>
</head><body>
<div id="ui">
  <h1>Pathfinder Fix — 3D Scene</h1>
  <div class="tabs" id="tabs"></div>
</div>
<div class="toggle">
  <label><input type="checkbox" id="showOrig" checked> ORIG path (red)</label>
  <label><input type="checkbox" id="showFixed" checked> FIXED path (green)</label>
  <label><input type="checkbox" id="showNodes" checked> A* nodes</label>
  <label><input type="checkbox" id="showLeaves" checked> Leaves</label>
</div>
<div id="info"></div>
<div id="legend">
  <div><span style="background:#3a7d22"></span> Ground</div>
  <div><span style="background:rgba(76,175,80,0.45)"></span> Leaves</div>
  <div><span style="background:#6b4f2e"></span> Log/Wood</div>
  <div><span style="background:#f0f0f0"></span> Snow</div>
  <div><span style="background:#ff4444"></span> ORIG trail</div>
  <div><span style="background:#44ff88"></span> FIXED trail</div>
  <div><span style="background:#ffcc00"></span> A* path nodes</div>
  <div><span style="background:#00ff00"></span> Start</div>
  <div><span style="background:#ff0000"></span> Goal</div>
</div>
<canvas id="canvas"></canvas>

<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"}}</script>
<script type="module">
import*as THREE from'three';
import{OrbitControls}from'three/addons/controls/OrbitControls.js';

const DATA=${JSON.stringify(vizData)};
let currentIdx=0;

const scene=new THREE.Scene();
scene.background=new THREE.Color(0x0d1117);
scene.fog=new THREE.Fog(0x0d1117,80,160);
const camera=new THREE.PerspectiveCamera(55,innerWidth/innerHeight,0.1,500);
const renderer=new THREE.WebGLRenderer({canvas:document.getElementById('canvas'),antialias:true});
renderer.setSize(innerWidth,innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true;controls.dampingFactor=0.08;controls.maxDistance=120;controls.minDistance=5;

scene.add(new THREE.AmbientLight(0x667788,1.2));
const dirLight=new THREE.DirectionalLight(0xffffff,1.5);
dirLight.position.set(20,30,10);scene.add(dirLight);

const MATS={};
function getMat(name){
  if(MATS[name])return MATS[name];
  let color=0x5a7d4a,opacity=1,transparent=false;
  if(name.includes('leaves')){color=name.includes('spruce')?0x2d5a2d:name.includes('birch')?0x5a9a3a:name.includes('dark')?0x3a6a2a:0x4a8c2a;opacity=0.45;transparent=true}
  else if(name.includes('log')||name.includes('wood')){color=name.includes('spruce')?0x3d2e1a:name.includes('birch')?0xd4cdb8:name.includes('dark')?0x3d2813:0x6b4f2e}
  else if(name.includes('grass'))color=0x3a7d22;
  else if(name.includes('dirt')||name.includes('podzol')||name.includes('mud'))color=0x8b6914;
  else if(name.includes('stone')||name.includes('ore'))color=0x808080;
  else if(name.includes('snow'))color=0xf0f0f0;
  else if(name.includes('sand'))color=0xe8d5a3;
  else if(name.includes('gravel'))color=0x9e9e9e;
  else if(name.includes('water')){color=0x3366cc;opacity=0.5;transparent=true}
  else if(name.includes('ice')){color=0xa0d0f0;opacity=0.6;transparent=true}
  const m=new THREE.MeshLambertMaterial({color,transparent,opacity,side:transparent?THREE.DoubleSide:THREE.FrontSide});
  MATS[name]=m;return m;
}

let sceneGroup=new THREE.Group();scene.add(sceneGroup);
let origGroup,fixedGroup,nodesGroup,leavesGroup;

function loadRoute(idx){
  currentIdx=idx;
  sceneGroup.clear();
  origGroup=new THREE.Group();fixedGroup=new THREE.Group();nodesGroup=new THREE.Group();leavesGroup=new THREE.Group();

  const rd=DATA[idx];const t=rd.terrain;
  const cx=(t.minX+t.maxX)/2,cy=(t.minY+t.maxY)/2,cz=(t.minZ+t.maxZ)/2;

  // Blocks
  const geo=new THREE.BoxGeometry(1,1,1);
  for(const b of t.blocks){
    const isLeaf=b.n.includes('leaves');
    const mesh=new THREE.Mesh(geo,getMat(b.n));
    mesh.position.set(b.x-cx,b.y-cy,b.z-cz);
    if(isLeaf)leavesGroup.add(mesh);else sceneGroup.add(mesh);
  }
  sceneGroup.add(leavesGroup);

  // Wireframe edges for solid blocks
  const edgeMat=new THREE.LineBasicMaterial({color:0x000000,transparent:true,opacity:0.15});
  const edgeGeo=new THREE.EdgesGeometry(geo);
  for(const b of t.blocks){
    if(b.s&&!b.n.includes('leaves')){
      const line=new THREE.LineSegments(edgeGeo,edgeMat);
      line.position.set(b.x-cx,b.y-cy,b.z-cz);sceneGroup.add(line);
    }
  }

  // A* path nodes
  const nodeGeo=new THREE.BoxGeometry(0.9,0.15,0.9);
  const origNodeMat=new THREE.MeshBasicMaterial({color:0xffcc00,transparent:true,opacity:0.5});
  const fixedNodeMat=new THREE.MeshBasicMaterial({color:0x00ccff,transparent:true,opacity:0.5});
  if(rd.orig.pathNodes)for(const n of rd.orig.pathNodes){const m=new THREE.Mesh(nodeGeo,origNodeMat);m.position.set(n[0]-cx+0.5,n[1]-cy+0.05,n[2]-cz+0.5);nodesGroup.add(m)}
  if(rd.fixed.pathNodes)for(const n of rd.fixed.pathNodes){const m=new THREE.Mesh(nodeGeo,fixedNodeMat);m.position.set(n[0]-cx+0.5,n[1]-cy+0.15,n[2]-cz+0.5);nodesGroup.add(m)}
  sceneGroup.add(nodesGroup);

  // Bot trails
  function makePath(posLog,color,yOff){
    if(!posLog||posLog.length<2)return new THREE.Group();
    const g=new THREE.Group();
    const pts=posLog.map(p=>new THREE.Vector3(p[0]-cx,p[1]-cy+yOff,p[2]-cz));
    const curve=new THREE.CatmullRomCurve3(pts,false);
    const tubeGeo=new THREE.TubeGeometry(curve,pts.length*4,0.12,6,false);
    const tubeMat=new THREE.MeshBasicMaterial({color,transparent:true,opacity:0.9});
    g.add(new THREE.Mesh(tubeGeo,tubeMat));
    // Spheres at positions
    const sGeo=new THREE.SphereGeometry(0.15,8,8);
    const sMat=new THREE.MeshBasicMaterial({color});
    for(const pt of pts){const s=new THREE.Mesh(sGeo,sMat);s.position.copy(pt);g.add(s)}
    return g;
  }
  origGroup=makePath(rd.orig.posLog,0xff4444,0.5);
  fixedGroup=makePath(rd.fixed.posLog,0x44ff88,0.7);
  sceneGroup.add(origGroup);sceneGroup.add(fixedGroup);

  // Start/Goal markers
  const startGeo=new THREE.SphereGeometry(0.5,16,16);
  const startMat=new THREE.MeshBasicMaterial({color:0x00ff00});
  const startM=new THREE.Mesh(startGeo,startMat);
  startM.position.set(rd.start.x-cx+0.5,rd.start.y-cy+1,rd.start.z-cz+0.5);sceneGroup.add(startM);
  // Start glow
  const startGlow=new THREE.Mesh(new THREE.SphereGeometry(0.8,16,16),new THREE.MeshBasicMaterial({color:0x00ff00,transparent:true,opacity:0.2}));
  startGlow.position.copy(startM.position);sceneGroup.add(startGlow);

  const goalGeo=new THREE.SphereGeometry(0.5,16,16);
  const goalMat=new THREE.MeshBasicMaterial({color:0xff0000});
  const goalM=new THREE.Mesh(goalGeo,goalMat);
  goalM.position.set(rd.goal.x-cx+0.5,rd.goal.y-cy+1,rd.goal.z-cz+0.5);sceneGroup.add(goalM);
  const goalGlow=new THREE.Mesh(new THREE.SphereGeometry(0.8,16,16),new THREE.MeshBasicMaterial({color:0xff0000,transparent:true,opacity:0.2}));
  goalGlow.position.copy(goalM.position);sceneGroup.add(goalGlow);

  // Stuck indicator for ORIG
  if(rd.orig.status==='STUCK'||rd.orig.status==='ERR'||rd.orig.status==='NOPATH'){
    if(rd.orig.posLog&&rd.orig.posLog.length>0){
      const last=rd.orig.posLog[rd.orig.posLog.length-1];
      const stuckGeo=new THREE.SphereGeometry(1.5,16,16);
      const stuckMat=new THREE.MeshBasicMaterial({color:0xff0000,transparent:true,opacity:0.15,wireframe:true});
      const stuckM=new THREE.Mesh(stuckGeo,stuckMat);
      stuckM.position.set(last[0]-cx,last[1]-cy+0.5,last[2]-cz);
      stuckM.userData.pulse=true;
      sceneGroup.add(stuckM);
    }
  }

  // Camera
  const sx=rd.start.x-cx,sz=rd.start.z-cz,gx=rd.goal.x-cx,gz=rd.goal.z-cz;
  const midX=(sx+gx)/2,midZ=(sz+gz)/2;
  controls.target.set(midX,0,midZ);
  const dist=Math.max(15,Math.hypot(rd.goal.x-rd.start.x,rd.goal.z-rd.start.z)*1.2);
  camera.position.set(midX+dist*0.6,dist*0.8,midZ+dist*0.6);
  controls.update();

  updateInfo(rd);
  updateTabs();
}

function updateInfo(rd){
  const fs=['STUCK','SLOW','ERR','NOPATH'];
  const isImp=fs.includes(rd.orig.status)&&rd.fixed.status==='PASS';
  const isReg=rd.orig.status==='PASS'&&fs.includes(rd.fixed.status);
  document.getElementById('info').innerHTML=
    '<h2>'+rd.name+'</h2>'+
    '<div class="row"><div class="box o"><div class="lbl">Original</div><div class="val s-'+rd.orig.status+'">'+rd.orig.status+' '+rd.orig.time+'s</div><div style="font-size:11px;color:#8b949e;margin-top:4px">DD:'+rd.orig.dangerDiags+' Resets:'+rd.orig.resets+(rd.orig.errMsg?' | '+rd.orig.errMsg:'')+'</div></div>'+
    '<div class="box f"><div class="lbl">Fixed</div><div class="val s-'+rd.fixed.status+'">'+rd.fixed.status+' '+rd.fixed.time+'s</div><div style="font-size:11px;color:#8b949e;margin-top:4px">DD:'+rd.fixed.dangerDiags+' Resets:'+rd.fixed.resets+(rd.fixed.errMsg?' | '+rd.fixed.errMsg:'')+'</div></div></div>'+
    '<div class="verdict '+(isImp?'imp':isReg?'reg':'sam')+'">'+(isImp?'★ ORIG FAIL → FIXED PASS':isReg?'✗ REGRESSION':'Same result — both '+(rd.orig.status==='PASS'?'pass':'fail'))+'</div>';
}

function updateTabs(){
  const tabs=document.getElementById('tabs');tabs.innerHTML='';
  const fs=['STUCK','SLOW','ERR','NOPATH'];
  DATA.forEach((rd,i)=>{
    const t=document.createElement('div');t.className='tab'+(i===currentIdx?' active':'');
    const isImp=fs.includes(rd.orig.status)&&rd.fixed.status==='PASS';
    const isReg=rd.orig.status==='PASS'&&fs.includes(rd.fixed.status);
    if(isImp)t.classList.add('improved');if(isReg)t.classList.add('regression');
    t.textContent=(i+1)+'. '+(rd.type==='canopy'?'🌳 ':'')+rd.name.split('(')[0].trim();
    t.onclick=()=>loadRoute(i);tabs.appendChild(t);
  });
}

// Toggle controls
document.getElementById('showOrig').onchange=e=>{if(origGroup)origGroup.visible=e.target.checked};
document.getElementById('showFixed').onchange=e=>{if(fixedGroup)fixedGroup.visible=e.target.checked};
document.getElementById('showNodes').onchange=e=>{if(nodesGroup)nodesGroup.visible=e.target.checked};
document.getElementById('showLeaves').onchange=e=>{if(leavesGroup)leavesGroup.visible=e.target.checked};

// Animate
function animate(){
  requestAnimationFrame(animate);
  controls.update();
  // Pulse stuck indicators
  const t=Date.now()*0.003;
  sceneGroup.traverse(c=>{if(c.userData&&c.userData.pulse){c.scale.setScalar(1+Math.sin(t)*0.3);c.material.opacity=0.1+Math.sin(t)*0.08}});
  renderer.render(scene,camera);
}

window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});

loadRoute(0);animate();
</script></body></html>`;
}

bot.on('error', (err) => console.error('[Bot Error]', err.message))
bot.on('kicked', (reason) => console.log('[Kicked]', reason))
