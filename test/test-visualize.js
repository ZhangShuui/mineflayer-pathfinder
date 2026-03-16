/**
 * Collects terrain + path data for key routes and generates interactive HTML visualization.
 * Runs both ORIG and FIXED, records bot positions, scans terrain blocks.
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
  console.log('[Bot] Spawned at', bot.entity.position.toString())
  await sleep(5000)
  const mcData = require('minecraft-data')(bot.version)

  // Go to the known best forest area
  bot.chat('/tp @s 800 100 0')
  await sleep(4000)
  let center = bot.entity.position.floored()
  if (Math.abs(center.x - 800) > 10) {
    console.log(`TP failed (at ${center}), retrying...`)
    bot.chat('/tp @s 800 100 0')
    await sleep(4000)
    center = bot.entity.position.floored()
  }
  console.log('Scanning forest at', center.toString())
  const forest = findForestInfo(bot, center, mcData, 60)
  console.log(`Found ${forest.trees.length} trees, ${forest.leafPositions.length} leaf positions, ${forest.leafHeadCount} head-leaves`)

  // Generate routes (same algorithm as A/B test)
  const routes = generateRoutes(bot, forest)
  console.log(`Generated ${routes.length} candidate routes`)

  // ══ PHASE 1: Quick screening — run ORIG on top 40 routes to find problematic ones ══
  const candidates = routes.slice(0, 40)
  console.log(`\nPhase 1: Quick screening ${candidates.length} routes (ORIG only)...`)
  const screenResults = []
  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i]
    process.stdout.write(`  [${i + 1}/${candidates.length}] ${r.desc} → `)
    const origResult = await runWithTracking(bot, r, true)
    console.log(`${origResult.status} ${origResult.time}s dd=${origResult.dangerDiags}`)
    screenResults.push({ route: r, origResult })
  }

  // Rank by "interestingness": failures first, then high dangerous diags, then high time
  const failStatuses = ['STUCK', 'SLOW', 'ERR', 'NOPATH']
  screenResults.sort((a, b) => {
    const aFail = failStatuses.includes(a.origResult.status) ? 1 : 0
    const bFail = failStatuses.includes(b.origResult.status) ? 1 : 0
    if (aFail !== bFail) return bFail - aFail
    if (a.origResult.dangerDiags !== b.origResult.dangerDiags) return b.origResult.dangerDiags - a.origResult.dangerDiags
    return b.origResult.time - a.origResult.time
  })

  // Pick top 8: failures first, then high-dd routes, plus 2 clean routes for contrast
  const interesting = screenResults.filter(s => failStatuses.includes(s.origResult.status) || s.origResult.dangerDiags >= 3).slice(0, 6)
  const clean = screenResults.filter(s => s.origResult.status === 'PASS' && s.origResult.dangerDiags === 0).slice(0, 2)
  const keyRoutes = [...interesting, ...clean]
  console.log(`\nPhase 1 done. Selected ${interesting.length} interesting + ${clean.length} clean = ${keyRoutes.length} routes\n`)

  // ══ PHASE 2: Detailed tracking on selected routes ══
  console.log('Phase 2: Detailed tracking with ORIG + FIXED...\n')
  const vizData = []

  for (let i = 0; i < keyRoutes.length; i++) {
    const { route: r, origResult: screenOrig } = keyRoutes[i]
    console.log(`━━━ [${i + 1}/${keyRoutes.length}] ${r.desc} (screen: ${screenOrig.status} dd=${screenOrig.dangerDiags}) ━━━`)

    // Scan terrain around route
    const terrain = scanTerrain(bot, r)

    // Run ORIG with full tracking
    console.log('  Running ORIG...')
    const origResult = await runWithTracking(bot, r, true)
    console.log(`    ${origResult.status} ${origResult.time}s dd=${origResult.dangerDiags}`)

    // Run FIXED with full tracking
    console.log('  Running FIXED...')
    const fixedResult = await runWithTracking(bot, r, false)
    console.log(`    ${fixedResult.status} ${fixedResult.time}s dd=${fixedResult.dangerDiags}`)

    vizData.push({
      name: r.desc,
      leafCount: r.lv,
      start: { x: r.sx, y: r.sy, z: r.sz },
      goal: { x: r.gx, y: r.gy, z: r.gz },
      terrain,
      orig: origResult,
      fixed: fixedResult
    })
    console.log()
  }

  // Generate HTML visualization
  const html = generateHTML(vizData)
  fs.writeFileSync('viz-pathfinder.html', html)
  console.log('Visualization saved to viz-pathfinder.html')

  bot.quit()
  await sleep(500)
  process.exit(0)
})

// ════════════════════════════════════════════════
//  TERRAIN SCANNING
// ════════════════════════════════════════════════

function scanTerrain (bot, route) {
  const margin = 8
  const minX = Math.min(route.sx, route.gx) - margin
  const maxX = Math.max(route.sx, route.gx) + margin
  const minZ = Math.min(route.sz, route.gz) - margin
  const maxZ = Math.max(route.sz, route.gz) + margin
  const baseY = Math.min(route.sy, route.gy)

  const blocks = {}
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let y = baseY - 3; y <= baseY + 10; y++) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (b && b.name !== 'air') {
          if (!blocks[`${x},${z}`]) blocks[`${x},${z}`] = []
          blocks[`${x},${z}`].push({ y, name: b.name, bb: b.boundingBox })
        }
      }
    }
  }

  return { minX, maxX, minZ, maxZ, baseY, blocks }
}

// ════════════════════════════════════════════════
//  PATH TRACKING
// ════════════════════════════════════════════════

async function runWithTracking (bot, route, isOrig) {
  const movements = new Movements(bot)
  movements.canDig = false
  movements.allowSprinting = true
  if (isOrig) {
    movements.allowBreakLeaves = false
    patchOriginalDiagonal(movements)
  }
  // FIXED uses defaults (new diagonal + allowBreakLeaves=true)

  // Teleport to start (double-TP for stable positioning)
  bot.pathfinder.setGoal(null)
  await sleep(500)
  bot.chat(`/tp @s ${route.sx + 0.5} 300 ${route.sz + 0.5}`)
  await sleep(800)
  bot.chat(`/tp @s ${route.sx + 0.5} ${route.sy} ${route.sz + 0.5}`)
  await sleep(1500)
  // Verify TP worked
  const pos = bot.entity.position
  const dist = Math.hypot(pos.x - (route.sx + 0.5), pos.z - (route.sz + 0.5))
  if (dist > 3) {
    console.log(`    WARNING: TP failed (dist=${dist.toFixed(1)}), retrying...`)
    bot.chat(`/tp @s ${route.sx + 0.5} 300 ${route.sz + 0.5}`)
    await sleep(800)
    bot.chat(`/tp @s ${route.sx + 0.5} ${route.sy} ${route.sz + 0.5}`)
    await sleep(1500)
  }

  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(null)
  await sleep(200)

  const posLog = []
  const pathNodes = []
  let dangerDiags = 0
  let resets = 0
  const startPos = bot.entity.position.clone()
  const t0 = Date.now()

  // Record position every 200ms
  const posI = setInterval(() => {
    if (bot.entity) {
      posLog.push({ x: +bot.entity.position.x.toFixed(2), z: +bot.entity.position.z.toFixed(2), y: +bot.entity.position.y.toFixed(2), t: Date.now() - t0 })
    }
  }, 200)

  // Capture path updates
  const pathH = (r) => {
    if (!r.path) return
    for (const node of r.path) {
      pathNodes.push({ x: Math.floor(node.x), z: Math.floor(node.z), y: Math.floor(node.y) })
    }
    // Count dangerous diags
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
  const resetH = () => { resets++ }
  bot.on('path_update', pathH)
  bot.on('path_reset', resetH)

  let status = 'PASS', errMsg = ''
  try {
    await Promise.race([
      bot.pathfinder.goto(new GoalNear(route.gx, route.gy, route.gz, 2)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 20000))
    ])
  } catch (err) {
    errMsg = err.message || String(err)
    if (errMsg === 'Timeout') {
      const recent = posLog.slice(-10)
      if (recent.length >= 6) {
        let maxD = 0
        for (let i = 0; i < recent.length; i++)
          for (let j = i + 1; j < recent.length; j++)
            maxD = Math.max(maxD, Math.hypot(recent[i].x - recent[j].x, recent[i].z - recent[j].z))
        status = maxD < 2 ? 'STUCK' : 'SLOW'
      } else { status = 'SLOW' }
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

  // Add final position
  if (bot.entity) {
    posLog.push({ x: +bot.entity.position.x.toFixed(2), z: +bot.entity.position.z.toFixed(2), y: +bot.entity.position.y.toFixed(2), t: Date.now() - t0 })
  }

  // De-dup path nodes
  const seen = new Set()
  const uniqueNodes = pathNodes.filter(n => {
    const k = `${n.x},${n.y},${n.z}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })

  return { status, time: parseFloat(elapsed), dangerDiags, resets, posLog, pathNodes: uniqueNodes, errMsg }
}

// ════════════════════════════════════════════════
//  FOREST / ROUTE FINDING (reused from A/B test)
// ════════════════════════════════════════════════

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

function generateRoutes (bot, forest) {
  const { trees, leafPositions } = forest
  const routes = []

  // Type A: Tree-to-tree
  for (let i = 0; i < trees.length; i++)
    for (let j = i + 1; j < trees.length; j++) {
      const dist = trees[i].distanceTo(trees[j])
      if (dist < 3 || dist > 30) continue
      const s = findNearestSafeSpot(bot, trees[i], 3)
      const g = findNearestSafeSpot(bot, trees[j], 3)
      if (!s || !g || s.distanceTo(g) < 3) continue
      const lv = countLeavesAlongLine(bot, s, g)
      if (lv >= 1) routes.push({ sx: s.x, sy: s.y, sz: s.z, gx: g.x, gy: g.y, gz: g.z, lv, desc: `T${i}→T${j} (${dist.toFixed(0)}m,${lv}lv)` })
    }

  // Type B: Around trees
  for (let i = 0; i < trees.length; i++)
    for (const [ox1, oz1, ox2, oz2] of [[-4, -4, 4, 4], [4, -4, -4, 4], [-4, 0, 4, 0], [0, -4, 0, 4], [-3, -3, 3, 3], [3, -3, -3, 3]]) {
      const s = findNearestSafeSpot(bot, new Vec3(trees[i].x + ox1, trees[i].y, trees[i].z + oz1), 3)
      const g = findNearestSafeSpot(bot, new Vec3(trees[i].x + ox2, trees[i].y, trees[i].z + oz2), 3)
      if (!s || !g || s.distanceTo(g) < 4) continue
      const lv = countLeavesAlongLine(bot, s, g)
      if (lv >= 1) routes.push({ sx: s.x, sy: s.y, sz: s.z, gx: g.x, gy: g.y, gz: g.z, lv, desc: `Around#${i} (${lv}lv)` })
    }

  // Type C: Leaf-to-leaf
  for (let i = 0; i < Math.min(leafPositions.length, 25); i++)
    for (let j = i + 1; j < Math.min(leafPositions.length, 25); j++) {
      const dist = leafPositions[i].distanceTo(leafPositions[j])
      if (dist < 4 || dist > 20) continue
      const s = findNearestSafeSpot(bot, leafPositions[i].offset(0, -1, 0), 3)
      const g = findNearestSafeSpot(bot, leafPositions[j].offset(0, -1, 0), 3)
      if (!s || !g || s.distanceTo(g) < 3) continue
      const lv = countLeavesAlongLine(bot, s, g)
      if (lv >= 2) routes.push({ sx: s.x, sy: s.y, sz: s.z, gx: g.x, gy: g.y, gz: g.z, lv, desc: `L${i}→L${j} (${dist.toFixed(0)}m,${lv}lv)` })
    }

  // De-dup
  const seen = new Set()
  return routes.filter(r => {
    const key = `${r.sx},${r.sy},${r.sz}-${r.gx},${r.gy},${r.gz}`
    if (seen.has(key)) return false
    seen.add(key); return true
  }).sort((a, b) => b.lv - a.lv)
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

// ════════════════════════════════════════════════
//  HTML GENERATION
// ════════════════════════════════════════════════

function generateHTML (vizData) {
  const dataJSON = JSON.stringify(vizData)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pathfinder Fix Visualization</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0d1117; color: #c9d1d9; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; padding: 20px; }
h1 { color: #58a6ff; font-size: 24px; margin-bottom: 8px; }
.subtitle { color: #8b949e; font-size: 14px; margin-bottom: 30px; }
.route-card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
.route-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 8px; }
.route-name { font-size: 18px; font-weight: 600; color: #f0f6fc; }
.leaf-badge { background: #238636; color: #fff; padding: 2px 10px; border-radius: 12px; font-size: 13px; }
.status-row { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.status-box { padding: 12px 20px; border-radius: 8px; min-width: 200px; flex: 1; }
.status-box.orig { background: #1c1210; border: 1px solid #6e3630; }
.status-box.fixed { background: #0d1f0d; border: 1px solid #2ea043; }
.status-box .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
.status-box.orig .label { color: #f85149; }
.status-box.fixed .label { color: #3fb950; }
.status-box .value { font-size: 20px; font-weight: 700; }
.status-box .detail { font-size: 12px; color: #8b949e; margin-top: 4px; }
.status-PASS { color: #3fb950; }
.status-STUCK { color: #f85149; }
.status-ERR { color: #f85149; }
.status-NOPATH { color: #d29922; }
.status-SLOW { color: #d29922; }
.verdict { padding: 8px 16px; border-radius: 8px; font-weight: 600; font-size: 14px; margin-bottom: 16px; display: inline-block; }
.verdict.improved { background: #0d2818; color: #3fb950; border: 1px solid #238636; }
.verdict.regression { background: #2d1210; color: #f85149; border: 1px solid #6e3630; }
.verdict.same { background: #1c1e24; color: #8b949e; border: 1px solid #30363d; }
.maps { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }
.map-container { text-align: center; }
.map-label { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.map-label.orig { color: #f85149; }
.map-label.fixed { color: #3fb950; }
canvas { border: 1px solid #30363d; border-radius: 8px; image-rendering: pixelated; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 16px; justify-content: center; }
.legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #8b949e; }
.legend-color { width: 14px; height: 14px; border-radius: 3px; border: 1px solid #30363d; }
.timeline { margin-top: 16px; }
.timeline canvas { width: 100%; height: 60px; }
.summary-card { background: #161b22; border: 1px solid #58a6ff; border-radius: 12px; padding: 24px; margin-bottom: 30px; }
.summary-card h2 { color: #58a6ff; font-size: 18px; margin-bottom: 12px; }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.summary-stat { text-align: center; padding: 12px; background: #0d1117; border-radius: 8px; }
.summary-stat .num { font-size: 28px; font-weight: 700; }
.summary-stat .lbl { font-size: 11px; color: #8b949e; margin-top: 4px; }
</style>
</head>
<body>
<h1>Pathfinder Diagonal Fix — Path Visualization</h1>
<p class="subtitle">ORIG = upstream (old diagonal, no leaf break) vs FIXED = patched (both intermediates check + leaf break)</p>

<div id="summary"></div>
<div id="routes"></div>

<script>
const DATA = ${dataJSON};

const COLORS = {
  grass_block: '#3a7d22', dirt: '#8b6914', stone: '#808080', coarse_dirt: '#6b5a3e',
  sand: '#e8d5a3', gravel: '#9e9e9e', water: '#3366cc', snow: '#f0f0f0', snow_block: '#e8e8e8',
  ice: '#a0d0f0',
  oak_log: '#6b4f2e', spruce_log: '#3d2e1a', birch_log: '#d4cdb8', dark_oak_log: '#3d2813',
  oak_leaves: '#4a8c2a', spruce_leaves: '#3a6b3a', birch_leaves: '#5a9a3a', dark_oak_leaves: '#3a7a2a',
  default_ground: '#5a7d4a', default_leaf: '#4a8c2a', default_log: '#6b4f2e'
};

function getBlockColor(name) {
  if (COLORS[name]) return COLORS[name];
  if (name.includes('leaves')) return COLORS.default_leaf;
  if (name.includes('log') || name.includes('wood')) return COLORS.default_log;
  if (name.includes('stone') || name.includes('ore')) return COLORS.stone;
  if (name.includes('dirt') || name.includes('podzol') || name.includes('mud')) return COLORS.dirt;
  if (name.includes('grass')) return COLORS.grass_block;
  if (name.includes('sand')) return COLORS.sand;
  if (name.includes('snow')) return COLORS.snow;
  if (name.includes('water')) return COLORS.water;
  return COLORS.default_ground;
}

function isLeaf(name) { return name && name.includes('leaves'); }
function isLog(name) { return name && (name.includes('log') || name.includes('wood')); }

// Render summary
function renderSummary() {
  const el = document.getElementById('summary');
  let improved = 0, regressed = 0, same = 0;
  const failS = ['STUCK','SLOW','ERR','NOPATH'];
  for (const r of DATA) {
    if (failS.includes(r.orig.status) && r.fixed.status === 'PASS') improved++;
    else if (r.orig.status === 'PASS' && failS.includes(r.fixed.status)) regressed++;
    else same++;
  }
  el.innerHTML = \`
    <div class="summary-card">
      <h2>Overview — \${DATA.length} Routes Visualized</h2>
      <div class="summary-grid">
        <div class="summary-stat"><div class="num" style="color:#3fb950">\${improved}</div><div class="lbl">ORIG Fail → FIXED Pass</div></div>
        <div class="summary-stat"><div class="num" style="color:#f85149">\${regressed}</div><div class="lbl">Regressions</div></div>
        <div class="summary-stat"><div class="num" style="color:#8b949e">\${same}</div><div class="lbl">Same Result</div></div>
        <div class="summary-stat"><div class="num" style="color:#d29922">\${DATA.reduce((s,r)=>s+r.orig.dangerDiags,0)}</div><div class="lbl">ORIG Danger Diags</div></div>
        <div class="summary-stat"><div class="num" style="color:#3fb950">\${DATA.reduce((s,r)=>s+r.fixed.dangerDiags,0)}</div><div class="lbl">FIXED Danger Diags</div></div>
      </div>
    </div>\`;
}

// Render each route
function renderRoute(routeData, index) {
  const container = document.getElementById('routes');
  const card = document.createElement('div');
  card.className = 'route-card';

  const failS = ['STUCK','SLOW','ERR','NOPATH'];
  const isImproved = failS.includes(routeData.orig.status) && routeData.fixed.status === 'PASS';
  const isRegression = routeData.orig.status === 'PASS' && failS.includes(routeData.fixed.status);
  const verdictClass = isImproved ? 'improved' : isRegression ? 'regression' : 'same';
  const verdictText = isImproved ? '★ ORIG FAIL → FIXED PASS' : isRegression ? '✗ REGRESSION' : 'Both ' + (routeData.orig.status === 'PASS' ? 'PASS' : 'FAIL');

  card.innerHTML = \`
    <div class="route-header">
      <span class="route-name">#\${index + 1} \${routeData.name}</span>
      <span class="leaf-badge">\${routeData.leafCount} leaves along path</span>
    </div>
    <div class="verdict \${verdictClass}">\${verdictText}</div>
    <div class="status-row">
      <div class="status-box orig">
        <div class="label">Original (upstream)</div>
        <div class="value status-\${routeData.orig.status}">\${routeData.orig.status} \${routeData.orig.time}s</div>
        <div class="detail">Danger diags: \${routeData.orig.dangerDiags} | Resets: \${routeData.orig.resets}\${routeData.orig.errMsg ? ' | ' + routeData.orig.errMsg : ''}</div>
      </div>
      <div class="status-box fixed">
        <div class="label">Fixed (patched)</div>
        <div class="value status-\${routeData.fixed.status}">\${routeData.fixed.status} \${routeData.fixed.time}s</div>
        <div class="detail">Danger diags: \${routeData.fixed.dangerDiags} | Resets: \${routeData.fixed.resets}\${routeData.fixed.errMsg ? ' | ' + routeData.fixed.errMsg : ''}</div>
      </div>
    </div>
    <div class="maps">
      <div class="map-container">
        <div class="map-label orig">ORIGINAL path</div>
        <canvas id="map-orig-\${index}" width="1" height="1"></canvas>
      </div>
      <div class="map-container">
        <div class="map-label fixed">FIXED path</div>
        <canvas id="map-fixed-\${index}" width="1" height="1"></canvas>
      </div>
    </div>
    <div class="legend">
      <div class="legend-item"><div class="legend-color" style="background:#3a7d22"></div>Ground</div>
      <div class="legend-item"><div class="legend-color" style="background:#2d5a1e;opacity:0.8"></div>Leaves (head level)</div>
      <div class="legend-item"><div class="legend-color" style="background:#6b4f2e"></div>Log/Wood</div>
      <div class="legend-item"><div class="legend-color" style="background:#ffcc00"></div>Path nodes</div>
      <div class="legend-item"><div class="legend-color" style="background:rgba(255,100,100,0.9)"></div>Bot trail (ORIG)</div>
      <div class="legend-item"><div class="legend-color" style="background:rgba(100,255,150,0.9)"></div>Bot trail (FIXED)</div>
      <div class="legend-item"><div class="legend-color" style="background:#00ff00"></div>Start</div>
      <div class="legend-item"><div class="legend-color" style="background:#ff3333"></div>Goal</div>
      <div class="legend-item"><div class="legend-color" style="background:#ff0000"></div>Stuck zone</div>
    </div>\`;

  container.appendChild(card);

  // Draw maps after DOM insertion
  requestAnimationFrame(() => {
    drawMap(routeData, index, 'orig');
    drawMap(routeData, index, 'fixed');
  });
}

function drawMap(routeData, index, version) {
  const canvas = document.getElementById(\`map-\${version}-\${index}\`);
  if (!canvas) return;
  const t = routeData.terrain;
  const SCALE = 12;
  const w = (t.maxX - t.minX + 1);
  const h = (t.maxZ - t.minZ + 1);
  canvas.width = w * SCALE;
  canvas.height = h * SCALE;
  canvas.style.width = Math.min(w * SCALE, 500) + 'px';
  canvas.style.height = Math.min(h * SCALE, 500) + 'px';
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw terrain blocks
  for (const [key, blocks] of Object.entries(t.blocks)) {
    const [bx, bz] = key.split(',').map(Number);
    const px = (bx - t.minX) * SCALE;
    const py = (bz - t.minZ) * SCALE;

    // Find ground block (highest non-leaf solid block at/below baseY+2)
    let ground = null, leafAtHead = null, logBlock = null;
    const sorted = blocks.sort((a, b) => a.y - b.y);
    for (const b of sorted) {
      if (isLog(b.name)) logBlock = b;
      if (isLeaf(b.name) && b.y >= t.baseY && b.y <= t.baseY + 2) leafAtHead = b;
      if (b.bb === 'block' && !isLeaf(b.name) && b.y <= t.baseY + 1) ground = b;
    }

    // Draw ground
    if (ground) {
      ctx.fillStyle = getBlockColor(ground.name);
      ctx.fillRect(px, py, SCALE, SCALE);
    }

    // Draw leaf overlay (semi-transparent)
    if (leafAtHead) {
      ctx.fillStyle = 'rgba(30, 100, 30, 0.7)';
      ctx.fillRect(px, py, SCALE, SCALE);
      // Cross-hatch for leaves
      ctx.strokeStyle = 'rgba(50, 140, 50, 0.5)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(px, py); ctx.lineTo(px + SCALE, py + SCALE);
      ctx.moveTo(px + SCALE, py); ctx.lineTo(px, py + SCALE);
      ctx.stroke();
    }

    // Draw log
    if (logBlock) {
      ctx.fillStyle = '#6b4f2e';
      const m = SCALE * 0.2;
      ctx.fillRect(px + m, py + m, SCALE - 2*m, SCALE - 2*m);
    }
  }

  // Grid lines (subtle)
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= w; x++) {
    ctx.beginPath(); ctx.moveTo(x * SCALE, 0); ctx.lineTo(x * SCALE, h * SCALE); ctx.stroke();
  }
  for (let z = 0; z <= h; z++) {
    ctx.beginPath(); ctx.moveTo(0, z * SCALE); ctx.lineTo(w * SCALE, z * SCALE); ctx.stroke();
  }

  const vd = routeData[version];

  // Draw A* path nodes
  if (vd.pathNodes && vd.pathNodes.length > 0) {
    ctx.fillStyle = 'rgba(255, 204, 0, 0.4)';
    for (const node of vd.pathNodes) {
      const px = (node.x - t.minX) * SCALE;
      const py = (node.z - t.minZ) * SCALE;
      ctx.fillRect(px + 1, py + 1, SCALE - 2, SCALE - 2);
    }
  }

  // Draw bot movement trail
  if (vd.posLog && vd.posLog.length > 1) {
    const trailColor = version === 'orig' ? 'rgba(255, 100, 100, 0.9)' : 'rgba(100, 255, 150, 0.9)';
    ctx.strokeStyle = trailColor;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const p0 = vd.posLog[0];
    ctx.moveTo((p0.x - t.minX) * SCALE + SCALE/2, (p0.z - t.minZ) * SCALE + SCALE/2);
    for (let i = 1; i < vd.posLog.length; i++) {
      const p = vd.posLog[i];
      ctx.lineTo((p.x - t.minX) * SCALE + SCALE/2, (p.z - t.minZ) * SCALE + SCALE/2);
    }
    ctx.stroke();

    // If STUCK, draw pulsing red zone at last position
    if (vd.status === 'STUCK' || (vd.status === 'ERR' && vd.time > 5)) {
      const last = vd.posLog[vd.posLog.length - 1];
      const lx = (last.x - t.minX) * SCALE + SCALE/2;
      const lz = (last.z - t.minZ) * SCALE + SCALE/2;
      for (let r = 3; r >= 1; r--) {
        ctx.beginPath();
        ctx.arc(lx, lz, SCALE * r * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = \`rgba(255, 0, 0, \${0.1 / r})\`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(lx, lz, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ff0000';
      ctx.fill();
      // Label
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = '#ff4444';
      ctx.fillText('STUCK', lx + 8, lz + 4);
    }
  }

  // Draw start marker
  const sx = (routeData.start.x - t.minX) * SCALE + SCALE/2;
  const sz = (routeData.start.z - t.minZ) * SCALE + SCALE/2;
  ctx.beginPath();
  ctx.arc(sx, sz, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#00ff00';
  ctx.fill();
  ctx.strokeStyle = '#003300';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = 'bold 10px sans-serif';
  ctx.fillStyle = '#00ff00';
  ctx.fillText('S', sx + 8, sz + 4);

  // Draw goal marker
  const gx = (routeData.goal.x - t.minX) * SCALE + SCALE/2;
  const gz = (routeData.goal.z - t.minZ) * SCALE + SCALE/2;
  ctx.beginPath();
  ctx.arc(gx, gz, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#ff3333';
  ctx.fill();
  ctx.strokeStyle = '#330000';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = 'bold 10px sans-serif';
  ctx.fillStyle = '#ff3333';
  ctx.fillText('G', gx + 8, gz + 4);
}

// Render everything
renderSummary();
DATA.forEach((r, i) => renderRoute(r, i));
</script>
</body>
</html>`;
}

bot.on('error', (err) => console.error('[Bot Error]', err.message))
bot.on('kicked', (reason) => console.log('[Kicked]', reason))
