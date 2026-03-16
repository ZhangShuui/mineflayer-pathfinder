/**
 * 12 real-world door scenarios with actual bot.pathfinder.goto
 * Focus on practical cases: houses with doors, corridors, mixed types
 */
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('./index')
const { GoalNear } = goals
const Vec3 = require('vec3')

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'PathBot', version: '1.20.4'
})
bot.loadPlugin(pathfinder)

const BY = 64
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
  console.log('  12 REAL-WORLD DOOR SCENARIOS (actual goto)')
  console.log('='.repeat(70))

  await scenario1_enterOakHouse()
  await scenario2_enterSpruceHouse()
  await scenario3_enterBirchHouse()
  await scenario4_enterDarkOakHouse()
  await scenario5_enterAcaciaHouse()
  await scenario6_enterJungleHouse()
  await scenario7_houseWithFenceGate()
  await scenario8_threeRoomHouse()
  await scenario9_enterFromInside()
  await scenario10_eastFacingDoorHouse()
  await scenario11_longPathThenHouse()
  await scenario12_houseWithProtectedWalls()

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

// =====================================================================
// Build a simple house: 7x5x7 with floor, walls, roof, closed door
// Origin (ox, BY, oz) is the SW corner. Door on south wall.
// =====================================================================
async function buildHouse (ox, oz, material, doorFacing) {
  const oy = BY
  // Floor
  await cmd(`/fill ${ox} ${oy - 1} ${oz} ${ox + 6} ${oy - 1} ${oz + 6} stone`)
  // Walls (hollow box)
  await cmd(`/fill ${ox} ${oy} ${oz} ${ox + 6} ${oy + 3} ${oz + 6} ${material}_planks`)
  await cmd(`/fill ${ox + 1} ${oy} ${oz + 1} ${ox + 5} ${oy + 2} ${oz + 5} air`)
  // Roof
  await cmd(`/fill ${ox} ${oy + 3} ${oz} ${ox + 6} ${oy + 3} ${oz + 6} ${material}_planks`)

  // Door placement based on facing
  let dx, dz
  if (doorFacing === 'south') { dx = 3; dz = 0 }
  else if (doorFacing === 'north') { dx = 3; dz = 6 }
  else if (doorFacing === 'east') { dx = 0; dz = 3 }
  else { dx = 6; dz = 3 } // west

  await cmd(`/setblock ${ox + dx} ${oy} ${oz + dz} ${material}_door[facing=${doorFacing},half=lower,hinge=left,open=false]`)
  await cmd(`/setblock ${ox + dx} ${oy + 1} ${oz + dz} ${material}_door[facing=${doorFacing},half=upper,hinge=left,open=false]`)

  return { doorX: ox + dx, doorZ: oz + dz }
}

async function clearHouse (ox, oz) {
  await cmd('/gamemode creative')
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 2} ${ox + 8} ${BY + 5} ${oz + 8} air`)
}

// =====================================================================
// SCENARIO 1-6: Enter houses of each wood material
// =====================================================================
async function scenario1_enterOakHouse () {
  const name = 'S1: enter oak house (south door)'
  const ox = 200, oz = 400
  await tp(ox + 3, BY + 5, oz + 3)
  await sleep(2000)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY + 5} ${oz + 8} air`)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY - 1} ${oz + 8} grass_block`)
  await buildHouse(ox, oz, 'oak', 'south')
  await sleep(1500)
  // Start outside, south of house. Goal inside house.
  await runHouseTest(name, ox + 3, oz - 3, ox + 3, oz + 3, oz)
  await clearHouse(ox, oz)
}

async function scenario2_enterSpruceHouse () {
  const name = 'S2: enter spruce house (south door)'
  const ox = 200, oz = 430
  await tp(ox + 3, BY + 5, oz + 3)
  await sleep(2000)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY + 5} ${oz + 8} air`)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY - 1} ${oz + 8} grass_block`)
  await buildHouse(ox, oz, 'spruce', 'south')
  await sleep(1500)
  await runHouseTest(name, ox + 3, oz - 3, ox + 3, oz + 3, oz)
  await clearHouse(ox, oz)
}

async function scenario3_enterBirchHouse () {
  const name = 'S3: enter birch house (south door)'
  const ox = 200, oz = 460
  await tp(ox + 3, BY + 5, oz + 3)
  await sleep(2000)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY + 5} ${oz + 8} air`)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY - 1} ${oz + 8} grass_block`)
  await buildHouse(ox, oz, 'birch', 'south')
  await sleep(1500)
  await runHouseTest(name, ox + 3, oz - 3, ox + 3, oz + 3, oz)
  await clearHouse(ox, oz)
}

async function scenario4_enterDarkOakHouse () {
  const name = 'S4: enter dark_oak house (south door)'
  const ox = 200, oz = 490
  await tp(ox + 3, BY + 5, oz + 3)
  await sleep(2000)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY + 5} ${oz + 8} air`)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY - 1} ${oz + 8} grass_block`)
  await buildHouse(ox, oz, 'dark_oak', 'south')
  await sleep(1500)
  await runHouseTest(name, ox + 3, oz - 3, ox + 3, oz + 3, oz)
  await clearHouse(ox, oz)
}

async function scenario5_enterAcaciaHouse () {
  const name = 'S5: enter acacia house (south door)'
  const ox = 200, oz = 520
  await tp(ox + 3, BY + 5, oz + 3)
  await sleep(2000)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY + 5} ${oz + 8} air`)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY - 1} ${oz + 8} grass_block`)
  await buildHouse(ox, oz, 'acacia', 'south')
  await sleep(1500)
  await runHouseTest(name, ox + 3, oz - 3, ox + 3, oz + 3, oz)
  await clearHouse(ox, oz)
}

async function scenario6_enterJungleHouse () {
  const name = 'S6: enter jungle house (south door)'
  const ox = 200, oz = 550
  await tp(ox + 3, BY + 5, oz + 3)
  await sleep(2000)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY + 5} ${oz + 8} air`)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY - 1} ${oz + 8} grass_block`)
  await buildHouse(ox, oz, 'jungle', 'south')
  await sleep(1500)
  await runHouseTest(name, ox + 3, oz - 3, ox + 3, oz + 3, oz)
  await clearHouse(ox, oz)
}

// =====================================================================
// SCENARIO 7: House with fence gate yard
// =====================================================================
async function scenario7_houseWithFenceGate () {
  const name = 'S7: house + fence gate yard'
  const ox = 200, oz = 580
  await tp(ox + 3, BY + 5, oz + 3)
  await sleep(2000)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 6} ${ox + 8} ${BY + 5} ${oz + 8} air`)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 6} ${ox + 8} ${BY - 1} ${oz + 8} grass_block`)
  await buildHouse(ox, oz, 'oak', 'south')
  // Fence yard around south side with gate
  await cmd(`/fill ${ox} ${BY} ${oz - 3} ${ox + 6} ${BY} ${oz - 3} oak_fence`)
  await cmd(`/fill ${ox} ${BY} ${oz - 3} ${ox} ${BY} ${oz - 1} oak_fence`)
  await cmd(`/fill ${ox + 6} ${BY} ${oz - 3} ${ox + 6} ${BY} ${oz - 1} oak_fence`)
  await cmd(`/setblock ${ox + 3} ${BY} ${oz - 3} oak_fence_gate[facing=south,open=false]`)
  await sleep(1500)
  // Start outside fence, must open gate + door
  await runHouseTest(name, ox + 3, oz - 5, ox + 3, oz + 3, oz - 3)
  await clearHouse(ox, oz)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 6} ${ox + 8} ${BY + 5} ${oz - 1} air`)
}

// =====================================================================
// SCENARIO 8: Three-room house (2 internal doors)
// =====================================================================
async function scenario8_threeRoomHouse () {
  const name = 'S8: three-room house (2 internal doors)'
  const ox = 200, oz = 620
  await tp(ox + 3, BY + 5, oz + 10)
  await sleep(2000)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY + 5} ${oz + 20} air`)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY - 1} ${oz + 20} grass_block`)
  // Long house: 7x5x19
  await cmd(`/fill ${ox} ${BY - 1} ${oz} ${ox + 6} ${BY - 1} ${oz + 18} stone`)
  await cmd(`/fill ${ox} ${BY} ${oz} ${ox + 6} ${BY + 3} ${oz + 18} oak_planks`)
  await cmd(`/fill ${ox + 1} ${BY} ${oz + 1} ${ox + 5} ${BY + 2} ${oz + 17} air`)
  await cmd(`/fill ${ox} ${BY + 3} ${oz} ${ox + 6} ${BY + 3} ${oz + 18} oak_planks`)
  // Entry door (south)
  await cmd(`/setblock ${ox + 3} ${BY} ${oz} oak_door[facing=south,half=lower,hinge=left,open=false]`)
  await cmd(`/setblock ${ox + 3} ${BY + 1} ${oz} oak_door[facing=south,half=upper,hinge=left,open=false]`)
  // Internal wall 1 + door at z+6
  await cmd(`/fill ${ox + 1} ${BY} ${oz + 6} ${ox + 5} ${BY + 2} ${oz + 6} oak_planks`)
  await cmd(`/setblock ${ox + 3} ${BY} ${oz + 6} oak_door[facing=south,half=lower,hinge=left,open=false]`)
  await cmd(`/setblock ${ox + 3} ${BY + 1} ${oz + 6} oak_door[facing=south,half=upper,hinge=left,open=false]`)
  // Internal wall 2 + door at z+12
  await cmd(`/fill ${ox + 1} ${BY} ${oz + 12} ${ox + 5} ${BY + 2} ${oz + 12} oak_planks`)
  await cmd(`/setblock ${ox + 3} ${BY} ${oz + 12} oak_door[facing=south,half=lower,hinge=left,open=false]`)
  await cmd(`/setblock ${ox + 3} ${BY + 1} ${oz + 12} oak_door[facing=south,half=upper,hinge=left,open=false]`)
  await sleep(1500)
  // Start outside, goal in back room
  await runHouseTest(name, ox + 3, oz - 3, ox + 3, oz + 15, oz)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY + 5} ${oz + 20} air`)
}

// =====================================================================
// SCENARIO 9: Start inside house, exit through door
// =====================================================================
async function scenario9_enterFromInside () {
  const name = 'S9: exit house through closed door'
  const ox = 200, oz = 660
  await tp(ox + 3, BY + 5, oz + 3)
  await sleep(2000)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY + 5} ${oz + 8} air`)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY - 1} ${oz + 8} grass_block`)
  await buildHouse(ox, oz, 'oak', 'south')
  await sleep(1500)
  // Start INSIDE, goal OUTSIDE
  await cmd('/gamemode survival')
  await tp(ox + 3, BY, oz + 3)
  await sleep(3000)

  const mov = new Movements(bot)
  mov.canDig = false
  mov.canOpenDoors = true
  mov.allowSprinting = false
  bot.pathfinder.setMovements(mov)

  const r = await doGoto(ox + 3, BY, oz - 3, 15000)
  const exited = bot.entity.position.z < oz
  record(name, r.status === 'PASS' && exited,
    `${r.status} ${r.time}s resets=${r.resets} exited=${exited}`)
  await clearHouse(ox, oz)
}

// =====================================================================
// SCENARIO 10: East-facing door house
// =====================================================================
async function scenario10_eastFacingDoorHouse () {
  const name = 'S10: enter house through east-facing door'
  const ox = 200, oz = 690
  await tp(ox + 3, BY + 5, oz + 3)
  await sleep(2000)
  await cmd(`/fill ${ox - 4} ${BY - 1} ${oz - 2} ${ox + 8} ${BY + 5} ${oz + 8} air`)
  await cmd(`/fill ${ox - 4} ${BY - 1} ${oz - 2} ${ox + 8} ${BY - 1} ${oz + 8} grass_block`)
  await buildHouse(ox, oz, 'oak', 'east')
  await sleep(1500)
  // Start east of house, enter through east door
  await cmd('/gamemode survival')
  await tp(ox - 3, BY, oz + 3)
  await sleep(3000)

  const mov = new Movements(bot)
  mov.canDig = false
  mov.canOpenDoors = true
  mov.allowSprinting = false
  bot.pathfinder.setMovements(mov)

  const r = await doGoto(ox + 3, BY, oz + 3, 15000)
  const entered = bot.entity.position.x > ox
  record(name, r.status === 'PASS' && entered,
    `${r.status} ${r.time}s resets=${r.resets} entered=${entered}`)
  await clearHouse(ox, oz)
  await cmd(`/fill ${ox - 4} ${BY - 1} ${oz - 2} ${ox - 1} ${BY + 5} ${oz + 8} air`)
}

// =====================================================================
// SCENARIO 11: Long outdoor path then enter house
// =====================================================================
async function scenario11_longPathThenHouse () {
  const name = 'S11: 20-block walk then enter house'
  const ox = 200, oz = 720
  await tp(ox + 3, BY + 5, oz + 10)
  await sleep(2000)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 22} ${ox + 8} ${BY + 5} ${oz + 8} air`)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 22} ${ox + 8} ${BY - 1} ${oz + 8} grass_block`)
  await buildHouse(ox, oz, 'spruce', 'south')
  await sleep(1500)
  // Start 20 blocks south
  await cmd('/gamemode survival')
  await tp(ox + 3, BY, oz - 20)
  await sleep(3000)

  const mov = new Movements(bot)
  mov.canDig = false
  mov.canOpenDoors = true
  mov.allowSprinting = false
  bot.pathfinder.setMovements(mov)

  const r = await doGoto(ox + 3, BY, oz + 3, 25000)
  const entered = bot.entity.position.z > oz
  record(name, r.status === 'PASS' && entered,
    `${r.status} ${r.time}s resets=${r.resets} entered=${entered}`)
  await clearHouse(ox, oz)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 22} ${ox + 8} ${BY + 5} ${oz - 1} air`)
}

// =====================================================================
// SCENARIO 12: Enter house but walls are protected (canDig+protect)
// =====================================================================
async function scenario12_houseWithProtectedWalls () {
  const name = 'S12: enter house, walls protected (canDig=true)'
  const ox = 200, oz = 760
  await tp(ox + 3, BY + 5, oz + 3)
  await sleep(2000)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY + 5} ${oz + 8} air`)
  await cmd(`/fill ${ox - 2} ${BY - 1} ${oz - 4} ${ox + 8} ${BY - 1} ${oz + 8} grass_block`)
  await buildHouse(ox, oz, 'oak', 'south')
  await sleep(1500)

  // Protect all wall blocks (not the door)
  const wallPositions = []
  for (let x = ox; x <= ox + 6; x++) {
    for (let y = BY; y <= BY + 3; y++) {
      for (let z = oz; z <= oz + 6; z++) {
        // Only shell blocks (not interior)
        if (x === ox || x === ox + 6 || y === BY + 3 || z === oz || z === oz + 6) {
          wallPositions.push({ x, y, z })
        }
      }
    }
  }

  await cmd('/gamemode survival')
  await tp(ox + 3, BY, oz - 3)
  await sleep(3000)

  const mov = new Movements(bot)
  mov.canDig = true
  mov.canOpenDoors = true
  mov.allowSprinting = false
  mov.protectBlocks(wallPositions)
  bot.pathfinder.setMovements(mov)

  const r = await doGoto(ox + 3, BY, oz + 3, 20000)
  const entered = bot.entity.position.z > oz

  // Verify walls intact
  let intact = 0
  let total = 0
  for (const pos of wallPositions) {
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
    if (b && b.name !== 'air') intact++
    total++
  }

  record(name, r.status === 'PASS' && entered,
    `${r.status} ${r.time}s entered=${entered} walls=${intact}/${total}`)
  await clearHouse(ox, oz)
}

// =====================================================================
// HELPERS
// =====================================================================

async function runHouseTest (name, startX, startZ, goalX, goalZ, doorZ) {
  await cmd('/gamemode survival')
  await tp(startX, BY, startZ)
  await sleep(3000)

  const mov = new Movements(bot)
  mov.canDig = false
  mov.canOpenDoors = true
  mov.allowSprinting = false
  bot.pathfinder.setMovements(mov)

  const r = await doGoto(goalX, BY, goalZ, 20000)
  const crossedDoor = Math.abs(bot.entity.position.z - doorZ) > 1 &&
    ((startZ < doorZ && bot.entity.position.z > doorZ) ||
     (startZ > doorZ && bot.entity.position.z < doorZ))
  record(name, r.status === 'PASS' && crossedDoor,
    `${r.status} ${r.time}s resets=${r.resets} crossed=${crossedDoor}`)
}

async function doGoto (gx, gy, gz, timeout) {
  let resets = 0
  const resetH = () => { resets++ }
  bot.on('path_reset', resetH)
  const t0 = Date.now()
  let status = 'PASS'
  try {
    await Promise.race([
      bot.pathfinder.goto(new GoalNear(gx, gy, gz, 2)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeout))
    ])
  } catch (err) {
    status = err.message === 'Timeout' ? 'TIMEOUT' : 'ERR'
  }
  const time = ((Date.now() - t0) / 1000).toFixed(1)
  bot.removeListener('path_reset', resetH)
  bot.pathfinder.setGoal(null)
  await sleep(500)
  return { status, time, resets }
}

function record (name, pass, detail) {
  results.push({ name, pass, detail })
  const icon = pass ? '✓' : '✗'
  console.log(`\n  ${icon} ${name}: ${detail}`)
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
