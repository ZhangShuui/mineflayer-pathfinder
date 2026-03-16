const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('./index')
const { GoalNear, GoalXZ } = goals
const Vec3 = require('vec3')

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'PathBot',
  version: '1.20.4'
})

bot.loadPlugin(pathfinder)

let pathResetCount = 0
let stuckDetections = 0
let lastPos = null
let stuckCheckInterval = null

bot.once('spawn', async () => {
  console.log('[Bot] Spawned at', bot.entity.position.toString())

  const mcData = require('minecraft-data')(bot.version)
  const movements = new Movements(bot)
  movements.canDig = false // critical: no block breaking
  movements.allowSprinting = true
  bot.pathfinder.setMovements(movements)

  // Wait for chunks to load
  await sleep(5000)
  console.log('[Bot] Chunks loaded.')

  // Scan surroundings
  const start = bot.entity.position.floored()
  scanTerrain(start, mcData)

  // Start stuck detection
  stuckCheckInterval = setInterval(() => {
    if (!bot.entity) return
    const pos = bot.entity.position
    if (lastPos && pos.distanceTo(lastPos) < 0.1) {
      stuckDetections++
      if (stuckDetections >= 6) {
        console.log(`  [STUCK] Bot hasn't moved for ~3s at ${pos.floored()}`)
      }
    } else {
      stuckDetections = 0
    }
    lastPos = pos.clone()
  }, 500)

  const results = { passed: 0, failed: 0, tests: [] }
  const timeout = 30000 // 30s per test

  // Test 1: Short distance - walk 20 blocks in one direction
  await runTest(results, 'Short walk (20 blocks)', timeout, async () => {
    const target = start.offset(20, 0, 0)
    console.log(`  Target: ${target}`)
    await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 3))
    console.log(`  Arrived: ${bot.entity.position.floored()}`)
  })

  // Test 2: Diagonal walk through terrain
  await runTest(results, 'Diagonal walk (25 blocks)', timeout, async () => {
    const target = start.offset(25, 0, 25)
    console.log(`  Target: ${target}`)
    await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 3))
    console.log(`  Arrived: ${bot.entity.position.floored()}`)
  })

  // Test 3: Find a tree and navigate near it
  await runTest(results, 'Navigate near a tree', timeout, async () => {
    const tree = findNearestTree(start, mcData)
    if (!tree) {
      console.log('  [SKIP] No trees found nearby')
      return
    }
    console.log(`  Tree at: ${tree}`)
    await bot.pathfinder.goto(new GoalNear(tree.x, tree.y, tree.z, 2))
    console.log(`  Arrived near tree: ${bot.entity.position.floored()}`)
  })

  // Test 4: Navigate to a point on the other side of a tree cluster
  await runTest(results, 'Navigate through forest area', 60000, async () => {
    const trees = findTrees(start, mcData, 5)
    if (trees.length < 2) {
      console.log('  [SKIP] Not enough trees for forest test')
      return
    }
    // Target beyond the tree cluster
    const avgX = trees.reduce((s, t) => s + t.x, 0) / trees.length
    const avgZ = trees.reduce((s, t) => s + t.z, 0) / trees.length
    const dx = avgX - start.x
    const dz = avgZ - start.z
    const target = new Vec3(Math.floor(avgX + dx), start.y, Math.floor(avgZ + dz))
    console.log(`  Trees found: ${trees.length}, navigating through to ${target}`)
    await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 4))
    console.log(`  Arrived: ${bot.entity.position.floored()}`)
  })

  // Test 5: Long distance GoalXZ (80 blocks)
  await runTest(results, 'Long distance GoalXZ (80 blocks)', 60000, async () => {
    const tx = start.x + 80
    const tz = start.z - 40
    console.log(`  Target: x=${tx}, z=${tz}`)
    await bot.pathfinder.goto(new GoalXZ(tx, tz))
    console.log(`  Arrived: ${bot.entity.position.floored()}`)
  })

  // Test 6: Navigate back to spawn through whatever terrain
  await runTest(results, 'Return to spawn', 60000, async () => {
    console.log(`  Target: near ${start}`)
    await bot.pathfinder.goto(new GoalNear(start.x, start.y, start.z, 3))
    console.log(`  Arrived: ${bot.entity.position.floored()}`)
  })

  // Test 7: Find highest nearby point and climb to it (hill test)
  await runTest(results, 'Climb to highest nearby point', 45000, async () => {
    const high = findHighPoint(start, 40)
    if (!high) {
      console.log('  [SKIP] No significant elevation changes nearby')
      return
    }
    console.log(`  Highest point: ${high} (${high.y - start.y} blocks up)`)
    await bot.pathfinder.goto(new GoalNear(high.x, high.y, high.z, 2))
    console.log(`  Arrived: ${bot.entity.position.floored()}`)
  })

  // Print results
  clearInterval(stuckCheckInterval)
  console.log('\n========== RESULTS ==========')
  for (const t of results.tests) {
    const icon = t.status === 'PASS' ? '✓' : t.status === 'SKIP' ? '-' : '✗'
    console.log(`  ${icon} ${t.name}: ${t.status}${t.error ? ' (' + t.error + ')' : ''} [${t.time}ms]`)
  }
  console.log(`\n  Passed: ${results.passed}/${results.tests.length}`)
  console.log(`  Path resets: ${pathResetCount}`)
  console.log('=============================\n')

  await sleep(1000)
  bot.quit()
  process.exit(0)
})

async function runTest (results, name, timeoutMs, fn) {
  console.log(`\n[Test] ${name}`)
  pathResetCount = 0
  stuckDetections = 0
  const t0 = Date.now()
  try {
    await Promise.race([
      fn(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
    ])
    const elapsed = Date.now() - t0
    results.passed++
    results.tests.push({ name, status: 'PASS', time: elapsed })
    console.log(`  [PASS] (${elapsed}ms, ${pathResetCount} resets)`)
  } catch (err) {
    const elapsed = Date.now() - t0
    // Stop current path and wait for pathfinder to fully settle
    bot.pathfinder.setGoal(null)
    await sleep(1000)
    if (err.message === 'Timeout') {
      results.tests.push({ name, status: 'TIMEOUT', error: 'exceeded ' + timeoutMs + 'ms', time: elapsed })
    } else {
      results.tests.push({ name, status: 'FAIL', error: err.message, time: elapsed })
    }
    results.failed++
    console.log(`  [FAIL] ${err.name}: ${err.message} (${elapsed}ms)`)
  }
}

function scanTerrain (center, mcData) {
  const radius = 30
  let trees = 0; let water = 0
  let minY = 999; let maxY = -999

  for (let x = -radius; x <= radius; x += 3) {
    for (let z = -radius; z <= radius; z += 3) {
      for (let y = center.y - 10; y <= center.y + 20; y++) {
        const block = bot.blockAt(new Vec3(center.x + x, y, center.z + z))
        if (!block) continue
        if (block.name.includes('log')) trees++
        if (block.name === 'water') water++
        if (block.type !== 0 && y > maxY) maxY = y
        if (block.type !== 0 && y < minY) minY = y
      }
    }
  }
  console.log(`[Terrain] logs=${trees} water=${water} elevation=${minY}-${maxY} (range ${maxY - minY})`)
}

function findNearestTree (center, mcData) {
  const radius = 40
  let closest = null; let closestDist = Infinity
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      for (let y = center.y - 5; y <= center.y + 10; y++) {
        const block = bot.blockAt(new Vec3(center.x + x, y, center.z + z))
        if (block && block.name.includes('log')) {
          const dist = Math.abs(x) + Math.abs(z)
          if (dist < closestDist && dist > 3) {
            closestDist = dist
            closest = new Vec3(center.x + x, y, center.z + z)
          }
        }
      }
    }
  }
  return closest
}

function findTrees (center, mcData, maxCount) {
  const trees = []
  const radius = 50
  const found = new Set()
  for (let x = -radius; x <= radius; x += 2) {
    for (let z = -radius; z <= radius; z += 2) {
      for (let y = center.y - 3; y <= center.y + 15; y++) {
        const block = bot.blockAt(new Vec3(center.x + x, y, center.z + z))
        if (block && block.name.includes('log')) {
          const key = `${center.x + x},${center.z + z}`
          if (!found.has(key)) {
            found.add(key)
            trees.push(new Vec3(center.x + x, y, center.z + z))
            if (trees.length >= maxCount) return trees
          }
        }
      }
    }
  }
  return trees
}

function findHighPoint (center, radius) {
  let highest = null; let highestY = center.y
  for (let x = -radius; x <= radius; x += 3) {
    for (let z = -radius; z <= radius; z += 3) {
      for (let y = center.y + 3; y <= center.y + 30; y++) {
        const block = bot.blockAt(new Vec3(center.x + x, y, center.z + z))
        const above = bot.blockAt(new Vec3(center.x + x, y + 1, center.z + z))
        const above2 = bot.blockAt(new Vec3(center.x + x, y + 2, center.z + z))
        if (block && above && above2 &&
            block.boundingBox === 'block' &&
            above.boundingBox === 'empty' &&
            above2.boundingBox === 'empty' &&
            y > highestY) {
          highestY = y
          highest = new Vec3(center.x + x, y + 1, center.z + z)
        }
      }
    }
  }
  return highest
}

bot.on('path_update', (r) => {
  const status = r.status === 'success' ? '✓' : r.status
  process.stdout.write(`  [path] ${status} | ${r.path.length} nodes | ${r.visitedNodes} visited | ${r.time.toFixed(0)}ms\n`)
})

bot.on('path_reset', (reason) => {
  pathResetCount++
  console.log(`  [path_reset] ${reason}`)
})

bot.on('goal_reached', () => {
  console.log('  [goal_reached]')
})

bot.on('error', (err) => {
  console.error('[Bot Error]', err.message)
})

bot.on('kicked', (reason) => {
  console.log('[Bot Kicked]', reason)
})

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
