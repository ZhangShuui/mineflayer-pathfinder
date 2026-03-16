/**
 * Comprehensive real-world door test:
 * - All 6 wood door materials (open + closed)
 * - Fence gates (open + closed)
 * - Trapdoors (open + closed)
 * - Iron door (must NOT be openable)
 * - Multiple facings
 * - Actual bot.pathfinder.goto (not just getPathTo)
 */
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('./index')
const { GoalNear } = goals
const Vec3 = require('vec3')

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'PathBot', version: '1.20.4'
})
bot.loadPlugin(pathfinder)

const BX = 200, BY = 64, BZ = 300

let lastChatTime = 0
async function cmd (msg) {
  const now = Date.now()
  const elapsed = now - lastChatTime
  if (elapsed < 1100) await sleep(1100 - elapsed)
  bot.chat(msg)
  lastChatTime = Date.now()
}

const results = []

bot.once('spawn', async () => {
  console.log('[Bot] Spawned')
  await sleep(5000)
  await cmd('/gamemode creative')
  await sleep(2000)

  console.log('\n' + '='.repeat(70))
  console.log('  COMPREHENSIVE DOOR / GATE / TRAPDOOR TEST')
  console.log('='.repeat(70) + '\n')

  // Test 1: All wood door materials — open door passthrough
  const doorMaterials = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak']
  for (const mat of doorMaterials) {
    await testDoorMaterial(mat, 'open')
  }

  // Test 2: Closed doors — should still be pathable (openable)
  for (const mat of ['oak', 'spruce']) {
    await testDoorMaterial(mat, 'closed')
  }

  // Test 3: Iron door — must NOT be openable by pathfinder
  await testIronDoor()

  // Test 4: Fence gates — open passthrough
  await testFenceGate('oak', 'open')
  await testFenceGate('oak', 'closed')

  // Test 5: Trapdoors — open passthrough (floor level)
  await testTrapdoor('oak', 'open')
  await testTrapdoor('oak', 'closed')

  // Test 6: Different facings for open doors
  for (const facing of ['north', 'south', 'east', 'west']) {
    await testDoorFacing(facing)
  }

  // Test 7: Actual goto walk-through (not just path computation)
  await testActualWalkthrough()

  // Summary
  console.log('\n' + '='.repeat(70))
  console.log('  RESULTS SUMMARY')
  console.log('='.repeat(70))
  let passed = 0
  let failed = 0
  for (const r of results) {
    const icon = r.pass ? '✓' : '✗'
    console.log(`  ${icon} ${r.name}: ${r.detail}`)
    if (r.pass) passed++
    else failed++
  }
  console.log(`\n  TOTAL: ${passed} passed, ${failed} failed out of ${results.length}`)
  console.log('='.repeat(70))

  bot.quit()
  await sleep(500)
  process.exit(failed > 0 ? 1 : 0)
})

// ========== Test implementations ==========

async function testDoorMaterial (material, state) {
  const testName = `${material}_door (${state})`
  const oz = BZ
  const open = state === 'open'

  await tp(BX + 1, BY + 5, oz + 7)
  await sleep(2000)

  // Build corridor
  await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY + 4} ${BZ + 12} air`)
  await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY - 1} ${BZ + 12} stone`)
  await cmd(`/fill ${BX - 1} ${BY} ${BZ - 1} ${BX - 1} ${BY + 3} ${BZ + 12} stone_bricks`)
  await cmd(`/fill ${BX + 2} ${BY} ${BZ - 1} ${BX + 2} ${BY + 3} ${BZ + 12} stone_bricks`)
  await cmd(`/fill ${BX - 1} ${BY + 3} ${BZ - 1} ${BX + 2} ${BY + 3} ${BZ + 12} stone_bricks`)

  // Cross wall with door
  await cmd(`/fill ${BX} ${BY} ${oz + 5} ${BX + 1} ${BY + 2} ${oz + 5} stone_bricks`)
  await cmd(`/setblock ${BX} ${BY} ${oz + 5} ${material}_door[facing=south,half=lower,hinge=left,open=${open}]`)
  await cmd(`/setblock ${BX} ${BY + 1} ${oz + 5} ${material}_door[facing=south,half=upper,hinge=left,open=${open}]`)
  await sleep(1500)

  await tp(BX + 0.5, BY, oz + 1)
  await sleep(2000)

  // Verify door placed
  const doorBlock = bot.blockAt(new Vec3(BX, BY, oz + 5))
  if (!doorBlock || !doorBlock.name.includes('door')) {
    record(testName, false, `door not placed: ${doorBlock ? doorBlock.name : 'null'}`)
    await cleanup(oz)
    return
  }

  const mov = new Movements(bot)
  mov.canDig = false
  mov.allowSprinting = false
  const gBlock = mov.getBlock(new Vec3(BX, BY, oz + 5), 0, 0, 0)

  if (open) {
    // Open door: should be passable (safe=true, physical=false)
    const passable = gBlock.safe && !gBlock.physical
    record(testName, passable,
      `safe=${gBlock.safe} physical=${gBlock.physical} openable=${gBlock.openable} height=${gBlock.height}`)
  } else {
    // Closed door: should be physical but openable
    const openable = gBlock.openable
    record(testName, openable,
      `safe=${gBlock.safe} physical=${gBlock.physical} openable=${gBlock.openable}`)
  }

  await cleanup(oz)
}

async function testIronDoor () {
  const testName = 'iron_door (must NOT be openable)'
  const oz = BZ

  await tp(BX + 1, BY + 5, oz + 7)
  await sleep(2000)

  await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY + 4} ${BZ + 12} air`)
  await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY - 1} ${BZ + 12} stone`)
  await cmd(`/fill ${BX} ${BY} ${oz + 5} ${BX + 1} ${BY + 2} ${oz + 5} stone_bricks`)
  await cmd(`/setblock ${BX} ${BY} ${oz + 5} iron_door[facing=south,half=lower,hinge=left,open=false]`)
  await cmd(`/setblock ${BX} ${BY + 1} ${oz + 5} iron_door[facing=south,half=upper,hinge=left,open=false]`)
  await sleep(1500)

  await tp(BX + 0.5, BY, oz + 1)
  await sleep(2000)

  const mov = new Movements(bot)
  mov.canDig = false
  const gBlock = mov.getBlock(new Vec3(BX, BY, oz + 5), 0, 0, 0)
  const notOpenable = !gBlock.openable
  record(testName, notOpenable,
    `openable=${gBlock.openable} (should be false)`)

  await cleanup(oz)
}

async function testFenceGate (material, state) {
  const testName = `${material}_fence_gate (${state})`
  const oz = BZ
  const open = state === 'open'

  await tp(BX + 1, BY + 5, oz + 7)
  await sleep(2000)

  await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY + 4} ${BZ + 12} air`)
  await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY - 1} ${BZ + 12} stone`)
  // Fence wall with gate
  await cmd(`/fill ${BX} ${BY} ${oz + 5} ${BX + 1} ${BY} ${oz + 5} ${material}_fence`)
  await cmd(`/setblock ${BX} ${BY} ${oz + 5} ${material}_fence_gate[facing=south,open=${open}]`)
  await sleep(1500)

  await tp(BX + 0.5, BY, oz + 1)
  await sleep(2000)

  const mov = new Movements(bot)
  mov.canDig = false
  const gBlock = mov.getBlock(new Vec3(BX, BY, oz + 5), 0, 0, 0)

  if (open) {
    const passable = gBlock.safe && !gBlock.physical
    record(testName, passable,
      `safe=${gBlock.safe} physical=${gBlock.physical} openable=${gBlock.openable}`)
  } else {
    const openable = gBlock.openable
    record(testName, openable,
      `openable=${gBlock.openable} physical=${gBlock.physical}`)
  }

  await cleanup(oz)
}

async function testTrapdoor (material, state) {
  const testName = `${material}_trapdoor (${state})`
  const oz = BZ
  const open = state === 'open'

  await tp(BX + 1, BY + 5, oz + 7)
  await sleep(2000)

  await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY + 4} ${BZ + 12} air`)
  await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY - 1} ${BZ + 12} stone`)
  // Trapdoor on the floor at BY level
  await cmd(`/setblock ${BX} ${BY} ${oz + 5} ${material}_trapdoor[facing=south,half=bottom,open=${open}]`)
  await sleep(1500)

  await tp(BX + 0.5, BY, oz + 1)
  await sleep(2000)

  const mov = new Movements(bot)
  mov.canDig = false
  const gBlock = mov.getBlock(new Vec3(BX, BY, oz + 5), 0, 0, 0)

  if (open) {
    // Open trapdoor (bottom, open=true) swings up → should be passable
    const passable = gBlock.safe && !gBlock.physical
    record(testName, passable,
      `safe=${gBlock.safe} physical=${gBlock.physical} openable=${gBlock.openable}`)
  } else {
    const openable = gBlock.openable
    record(testName, openable,
      `openable=${gBlock.openable} physical=${gBlock.physical}`)
  }

  await cleanup(oz)
}

async function testDoorFacing (facing) {
  const testName = `oak_door facing=${facing} (open)`
  const oz = BZ

  await tp(BX + 1, BY + 5, oz + 7)
  await sleep(2000)

  await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY + 4} ${BZ + 12} air`)
  await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY - 1} ${BZ + 12} stone`)
  await cmd(`/fill ${BX - 1} ${BY} ${BZ - 1} ${BX - 1} ${BY + 3} ${BZ + 12} stone_bricks`)
  await cmd(`/fill ${BX + 2} ${BY} ${BZ - 1} ${BX + 2} ${BY + 3} ${BZ + 12} stone_bricks`)
  await cmd(`/fill ${BX - 1} ${BY + 3} ${BZ - 1} ${BX + 2} ${BY + 3} ${BZ + 12} stone_bricks`)
  await cmd(`/fill ${BX} ${BY} ${oz + 5} ${BX + 1} ${BY + 2} ${oz + 5} stone_bricks`)
  await cmd(`/setblock ${BX} ${BY} ${oz + 5} oak_door[facing=${facing},half=lower,hinge=left,open=true]`)
  await cmd(`/setblock ${BX} ${BY + 1} ${oz + 5} oak_door[facing=${facing},half=upper,hinge=left,open=true]`)
  await sleep(1500)

  await tp(BX + 0.5, BY, oz + 1)
  await sleep(2000)

  const mov = new Movements(bot)
  mov.canDig = false
  const gBlock = mov.getBlock(new Vec3(BX, BY, oz + 5), 0, 0, 0)
  const passable = gBlock.safe && !gBlock.physical
  record(testName, passable,
    `safe=${gBlock.safe} physical=${gBlock.physical} shapes=${JSON.stringify(gBlock.shapes)}`)

  await cleanup(oz)
}

async function testActualWalkthrough () {
  const testName = 'ACTUAL GOTO: walk through open oak_door'
  const oz = BZ + 50

  await tp(BX + 1, BY + 5, oz + 7)
  await sleep(2000)

  // Build corridor with open door
  await cmd(`/fill ${BX - 1} ${BY - 1} ${oz - 1} ${BX + 2} ${BY + 4} ${oz + 12} air`)
  await cmd(`/fill ${BX - 1} ${BY - 1} ${oz - 1} ${BX + 2} ${BY - 1} ${oz + 12} stone`)
  await cmd(`/fill ${BX - 1} ${BY} ${oz - 1} ${BX - 1} ${BY + 3} ${oz + 12} stone_bricks`)
  await cmd(`/fill ${BX + 2} ${BY} ${oz - 1} ${BX + 2} ${BY + 3} ${oz + 12} stone_bricks`)
  await cmd(`/fill ${BX - 1} ${BY + 3} ${oz - 1} ${BX + 2} ${BY + 3} ${oz + 12} stone_bricks`)
  await cmd(`/fill ${BX} ${BY} ${oz + 5} ${BX + 1} ${BY + 2} ${oz + 5} stone_bricks`)
  await cmd(`/setblock ${BX} ${BY} ${oz + 5} oak_door[facing=south,half=lower,hinge=left,open=true]`)
  await cmd(`/setblock ${BX} ${BY + 1} ${oz + 5} oak_door[facing=south,half=upper,hinge=left,open=true]`)
  await sleep(1500)

  await tp(BX + 0.5, BY, oz + 1)
  await sleep(3000)

  const mov = new Movements(bot)
  mov.canDig = false
  mov.allowSprinting = false
  bot.pathfinder.setMovements(mov)

  const gx = BX + 0.5, gy = BY, gz = oz + 10
  const startPos = bot.entity.position.clone()

  let status = 'PASS'
  try {
    await Promise.race([
      bot.pathfinder.goto(new GoalNear(gx, gy, gz, 2)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 15000))
    ])
  } catch (err) {
    status = err.message === 'Timeout' ? 'TIMEOUT' : 'ERR: ' + err.message
  }

  bot.pathfinder.setGoal(null)
  await sleep(500)

  const endPos = bot.entity.position
  const goalDist = endPos.distanceTo(new Vec3(gx, gy, gz))
  const passed = status === 'PASS' && goalDist < 3
  // Check bot actually crossed the door z-line
  const crossedDoor = endPos.z > oz + 5
  record(testName, passed && crossedDoor,
    `status=${status} goalDist=${goalDist.toFixed(1)} endZ=${endPos.z.toFixed(1)} crossedDoor=${crossedDoor}`)

  await cmd(`/fill ${BX - 1} ${BY - 1} ${oz - 1} ${BX + 2} ${BY + 4} ${oz + 12} air`)
}

// ========== Helpers ==========

function record (name, pass, detail) {
  results.push({ name, pass, detail })
  const icon = pass ? '✓' : '✗'
  console.log(`  ${icon} ${name}: ${detail}`)
}

async function cleanup (oz) {
  await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY + 4} ${BZ + 12} air`)
}

async function tp (x, y, z) {
  bot.pathfinder.setGoal(null)
  await sleep(300)
  await cmd(`/tp @s ${x} 300 ${z}`)
  await cmd(`/tp @s ${x} ${y} ${z}`)
  await sleep(1500)
}

function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
bot.on('error', (err) => console.error('[Bot Error]', err.message))
bot.on('kicked', (reason) => { console.error('[Kicked]', JSON.stringify(reason)); process.exit(1) })
