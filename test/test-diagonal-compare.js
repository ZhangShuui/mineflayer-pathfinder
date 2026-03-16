/**
 * Diagonal Movement Comparison Test
 *
 * This test creates a controlled scenario with leaf blocks at diagonal
 * intermediate positions and compares the behavior of:
 *   - ORIGINAL code: only checks the cheaper intermediate (buggy)
 *   - FIXED code: requires both intermediates to be passable
 *
 * Scenario: leaf blocks placed at head height at one intermediate of a
 * diagonal move. The bot's 0.6-wide hitbox clips BOTH intermediates
 * during diagonal movement, so both must be clear.
 */

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('./index')
const { GoalBlock } = goals
const Vec3 = require('vec3')

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'PathBot',
  version: '1.20.4'
})

bot.loadPlugin(pathfinder)

const GROUND_Y = -60 // superflat ground surface (grass block at -61, player at -60)

bot.once('spawn', async () => {
  console.log('[Bot] Spawned at', bot.entity.position.toString())
  await sleep(3000)

  // Teleport to a clean area
  bot.chat('/tp @s 0 -60 0')
  await sleep(1000)

  const mcData = require('minecraft-data')(bot.version)
  console.log('[Setup] Building test scenarios...\n')

  // ============================================================
  // SCENARIO 1: Single leaf at diagonal intermediate
  // ============================================================
  // Start: (0, -60, 0)  Goal: (4, -60, 4)
  // Leaf at (1, -59, 0) = head height at intermediate 2 of diagonal (0,-60,0)->(1,-60,1)
  //
  // For diagonal dir=(1,0,1) from node (0,-60,0):
  //   intermediate 1: body=(0,-60,1) head=(0,-59,1) — air (clear)
  //   intermediate 2: body=(1,-60,0) head=(1,-59,0) — body=air, HEAD=LEAF (blocked!)
  //
  // Original: picks cheaper intermediate (1), allows diagonal
  // Fixed: both must be clear, blocks diagonal
  // ============================================================
  await placeBlock(0, GROUND_Y - 1, 0, 'grass_block') // ensure ground
  await placeBlock(1, GROUND_Y + 1, 0, 'oak_leaves') // leaf at head height
  console.log('[Scenario 1] Leaf at (1, -59, 0) - head height at diagonal intermediate')

  // ============================================================
  // SCENARIO 2: Tree-like structure with leaves at corners
  // ============================================================
  // Build a small tree at (20, -60, 20)
  // Log trunk
  for (let y = GROUND_Y; y <= GROUND_Y + 3; y++) {
    await placeBlock(20, y, 20, 'oak_log')
  }
  // Leaves around trunk at ground+2 and ground+3
  const leafPositions = []
  for (let dy = 2; dy <= 3; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dz === 0) continue // trunk
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue // corners too far
        await placeBlock(20 + dx, GROUND_Y + dy, 20 + dz, 'oak_leaves')
        leafPositions.push(new Vec3(20 + dx, GROUND_Y + dy, 20 + dz))
      }
    }
  }
  // Critical: leaves at ground+1 level (just above head) near trunk
  // These are at head height for a bot standing at ground level
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    await placeBlock(20 + dx, GROUND_Y + 1, 20 + dz, 'oak_leaves')
    leafPositions.push(new Vec3(20 + dx, GROUND_Y + 1, 20 + dz))
  }
  console.log(`[Scenario 2] Tree at (20,-60,20) with ${leafPositions.length} leaf blocks`)
  console.log('             Leaves at ground+1 (head height) around trunk')

  // ============================================================
  // SCENARIO 3: Narrow gap with leaf at corner
  // ============================================================
  // Wall from (40,-60,38) to (40,-60,42), gap at z=40
  // Leaf at (41,-59,40) — blocks diagonal through the gap
  for (let z = 38; z <= 42; z++) {
    if (z === 40) continue // gap
    await placeBlock(40, GROUND_Y, z, 'stone')
    await placeBlock(40, GROUND_Y + 1, z, 'stone')
  }
  await placeBlock(41, GROUND_Y + 1, 40, 'oak_leaves') // leaf at gap corner
  console.log('[Scenario 3] Wall with gap at (40,-60,40), leaf at corner (41,-59,40)')

  await sleep(1000)

  // ============================================================
  // RUN TESTS: Fixed version (our code)
  // ============================================================
  console.log('\n' + '='.repeat(60))
  console.log('  FIXED VERSION (both intermediates checked)')
  console.log('='.repeat(60))

  const fixedMovements = new Movements(bot)
  fixedMovements.canDig = false
  fixedMovements.allowSprinting = false

  console.log('\n--- Scenario 1: Leaf at diagonal intermediate ---')
  await testPath(fixedMovements, 'Fixed', 0, GROUND_Y, 0, 4, GROUND_Y, 4)

  console.log('\n--- Scenario 2: Navigate around tree ---')
  await testPath(fixedMovements, 'Fixed', 17, GROUND_Y, 17, 23, GROUND_Y, 23)

  console.log('\n--- Scenario 3: Navigate through wall gap ---')
  await testPath(fixedMovements, 'Fixed', 39, GROUND_Y, 38, 42, GROUND_Y, 42)

  // ============================================================
  // RUN TESTS: Original version (monkey-patched)
  // ============================================================
  console.log('\n' + '='.repeat(60))
  console.log('  ORIGINAL VERSION (only checks cheaper intermediate)')
  console.log('='.repeat(60))

  const origMovements = new Movements(bot)
  origMovements.canDig = false
  origMovements.allowSprinting = false

  // Monkey-patch getMoveDiagonal with the ORIGINAL buggy logic
  patchOriginalDiagonal(origMovements)

  console.log('\n--- Scenario 1: Leaf at diagonal intermediate ---')
  await testPath(origMovements, 'Original', 0, GROUND_Y, 0, 4, GROUND_Y, 4)

  console.log('\n--- Scenario 2: Navigate around tree ---')
  await testPath(origMovements, 'Original', 17, GROUND_Y, 17, 23, GROUND_Y, 23)

  console.log('\n--- Scenario 3: Navigate through wall gap ---')
  await testPath(origMovements, 'Original', 39, GROUND_Y, 38, 42, GROUND_Y, 42)

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n' + '='.repeat(60))
  console.log('  COMPARISON COMPLETE')
  console.log('='.repeat(60))

  await sleep(500)
  bot.quit()
  process.exit(0)
})

async function testPath (movements, label, sx, sy, sz, gx, gy, gz) {
  // Teleport bot to start
  bot.chat(`/tp @s ${sx + 0.5} ${sy} ${sz + 0.5}`)
  await sleep(500)

  bot.pathfinder.setMovements(movements)

  // Get path without actually moving
  const result = bot.pathfinder.getPathTo(movements, new GoalBlock(gx, gy, gz))
  const path = result.path

  console.log(`  [${label}] Status: ${result.status} | Path: ${path.length} nodes | Visited: ${result.visitedNodes}`)

  if (path.length === 0) {
    console.log(`  [${label}] No path found!`)
    return
  }

  // Print path nodes
  const pathStr = path.map(n => `(${n.x},${n.y},${n.z})`).join(' -> ')
  console.log(`  [${label}] Path: ${pathStr}`)

  // Check for diagonal moves through leaf-blocked intermediates
  let dangerousDiagonals = 0
  for (let i = 0; i < path.length; i++) {
    const prev = i === 0 ? { x: sx, y: sy, z: sz } : path[i - 1]
    const curr = path[i]
    const dx = curr.x - prev.x
    const dz = curr.z - prev.z

    if (Math.abs(dx) === 1 && Math.abs(dz) === 1) {
      // Diagonal move — check intermediates for leaf blocks
      const inter1 = bot.blockAt(new Vec3(prev.x, prev.y + 1, prev.z + dz))
      const inter2 = bot.blockAt(new Vec3(prev.x + dx, prev.y + 1, prev.z))
      const i1Blocked = inter1 && inter1.boundingBox === 'block'
      const i2Blocked = inter2 && inter2.boundingBox === 'block'

      if (i1Blocked || i2Blocked) {
        dangerousDiagonals++
        console.log(`  [${label}] ⚠ DANGEROUS diagonal (${prev.x},${prev.z})->(${curr.x},${curr.z})`)
        if (i1Blocked) console.log(`         intermediate 1 blocked by ${inter1.name} at (${prev.x},${prev.y + 1},${prev.z + dz})`)
        if (i2Blocked) console.log(`         intermediate 2 blocked by ${inter2.name} at (${prev.x + dx},${prev.y + 1},${prev.z})`)
      }
    }
  }

  if (dangerousDiagonals === 0) {
    console.log(`  [${label}] ✓ No dangerous diagonals — path is safe`)
  } else {
    console.log(`  [${label}] ✗ ${dangerousDiagonals} dangerous diagonal(s) — bot would clip solid blocks!`)
  }

  // Actually walk the path and check for getting stuck
  console.log(`  [${label}] Walking the path...`)
  const startPos = bot.entity.position.clone()
  try {
    await Promise.race([
      bot.pathfinder.goto(new GoalBlock(gx, gy, gz)),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('WalkTimeout')), 15000))
    ])
    const endPos = bot.entity.position.floored()
    const goalDist = endPos.distanceTo(new Vec3(gx, gy, gz))
    console.log(`  [${label}] ✓ Arrived at ${endPos} (${goalDist.toFixed(1)} from goal)`)
  } catch (err) {
    const endPos = bot.entity.position.floored()
    const movedDist = endPos.distanceTo(startPos)
    if (err.message === 'WalkTimeout') {
      console.log(`  [${label}] ✗ STUCK! Timed out at ${endPos} (moved ${movedDist.toFixed(1)} blocks)`)
    } else {
      console.log(`  [${label}] ✗ Error: ${err.name}: ${err.message} at ${endPos}`)
    }
  }

  // Reset pathfinder state
  bot.pathfinder.setGoal(null)
  await sleep(500)
}

/**
 * Monkey-patch movements with the ORIGINAL (buggy) diagonal logic
 * that only checks the cheaper intermediate instead of both.
 */
function patchOriginalDiagonal (movements) {
  const Move = require('./lib/move')

  movements.getMoveDiagonal = function (node, dir, neighbors) {
    let cost = Math.SQRT2
    const toBreak = []

    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const y = blockC.physical ? 1 : 0

    const block0 = this.getBlock(node, 0, -1, 0)

    let cost1 = 0
    const toBreak1 = []
    const blockB1 = this.getBlock(node, 0, y + 1, dir.z)
    const blockC1 = this.getBlock(node, 0, y, dir.z)
    const blockD1 = this.getBlock(node, 0, y - 1, dir.z)
    cost1 += this.safeOrBreak(blockB1, toBreak1)
    cost1 += this.safeOrBreak(blockC1, toBreak1)
    if (blockD1.height - block0.height > 1.2) cost1 += this.safeOrBreak(blockD1, toBreak1)

    let cost2 = 0
    const toBreak2 = []
    const blockB2 = this.getBlock(node, dir.x, y + 1, 0)
    const blockC2 = this.getBlock(node, dir.x, y, 0)
    const blockD2 = this.getBlock(node, dir.x, y - 1, 0)
    cost2 += this.safeOrBreak(blockB2, toBreak2)
    cost2 += this.safeOrBreak(blockC2, toBreak2)
    if (blockD2.height - block0.height > 1.2) cost2 += this.safeOrBreak(blockD2, toBreak2)

    // ORIGINAL BUG: only check the cheaper intermediate
    // The bot's hitbox (0.6 blocks wide) clips BOTH intermediates,
    // but this only validates one of them
    if (cost1 < cost2) {
      cost += cost1
      toBreak.push(...toBreak1)
    } else {
      cost += cost2
      toBreak.push(...toBreak2)
    }
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
      if (cost > 100) return
      cost += 1
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

async function placeBlock (x, y, z, blockName) {
  bot.chat(`/setblock ${x} ${y} ${z} minecraft:${blockName}`)
  await sleep(100)
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

bot.on('error', (err) => console.error('[Bot Error]', err.message))
bot.on('kicked', (reason) => console.log('[Kicked]', reason))
