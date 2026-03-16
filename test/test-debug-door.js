/**
 * Debug test: inspect open door block properties and pathfinding behavior
 */
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('./index')
const { GoalNear } = goals
const Vec3 = require('vec3')

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'PathBot', version: '1.20.4'
})
bot.loadPlugin(pathfinder)

const BX = 200, BY = 64, BZ = 250

let lastChatTime = 0
async function cmd (msg) {
  const now = Date.now()
  const elapsed = now - lastChatTime
  if (elapsed < 1100) await sleep(1100 - elapsed)
  bot.chat(msg)
  lastChatTime = Date.now()
}

bot.once('spawn', async () => {
  console.log('[Bot] Spawned')
  await sleep(5000)
  await cmd('/gamemode creative')
  await sleep(2000)

  // TP to area
  await cmd(`/tp @s ${BX} ${BY + 5} ${BZ}`)
  await sleep(3000)

  // Clear area and build simple corridor
  await cmd(`/fill ${BX - 2} ${BY - 1} ${BZ - 2} ${BX + 4} ${BY + 5} ${BZ + 12} air`)
  await cmd(`/fill ${BX - 2} ${BY - 1} ${BZ - 2} ${BX + 4} ${BY - 1} ${BZ + 12} stone`)

  // Walls enclosing corridor: left, right, back, front (with gaps for start/end)
  await cmd(`/fill ${BX - 1} ${BY} ${BZ - 1} ${BX - 1} ${BY + 3} ${BZ + 11} stone_bricks`)
  await cmd(`/fill ${BX + 2} ${BY} ${BZ - 1} ${BX + 2} ${BY + 3} ${BZ + 11} stone_bricks`)
  await cmd(`/fill ${BX - 1} ${BY + 3} ${BZ - 1} ${BX + 2} ${BY + 3} ${BZ + 11} stone_bricks`)

  // Cross wall at z+5 with door opening
  await cmd(`/fill ${BX} ${BY} ${BZ + 5} ${BX + 1} ${BY + 2} ${BZ + 5} stone_bricks`)

  // Place a single open door at BX, BY, BZ+5
  await cmd(`/setblock ${BX} ${BY} ${BZ + 5} oak_door[facing=south,half=lower,hinge=left,open=true]`)
  await cmd(`/setblock ${BX} ${BY + 1} ${BZ + 5} oak_door[facing=south,half=upper,hinge=left,open=true]`)

  await sleep(2000)
  await cmd(`/tp @s ${BX + 0.5} ${BY} ${BZ + 0.5}`)
  await sleep(3000)

  // Inspect door block
  const doorLower = bot.blockAt(new Vec3(BX, BY, BZ + 5))
  const doorUpper = bot.blockAt(new Vec3(BX, BY + 1, BZ + 5))

  console.log('\n=== Door Block Analysis ===')
  if (doorLower) {
    console.log(`Lower door: name=${doorLower.name} type=${doorLower.type}`)
    console.log(`  boundingBox: ${doorLower.boundingBox}`)
    console.log(`  shapes: ${JSON.stringify(doorLower.shapes)}`)
    if (doorLower.getProperties) {
      console.log(`  properties: ${JSON.stringify(doorLower.getProperties())}`)
    }
    console.log(`  stateId: ${doorLower.stateId}`)
  } else {
    console.log('Lower door: NOT FOUND')
  }

  if (doorUpper) {
    console.log(`Upper door: name=${doorUpper.name} type=${doorUpper.type}`)
    console.log(`  boundingBox: ${doorUpper.boundingBox}`)
    console.log(`  shapes: ${JSON.stringify(doorUpper.shapes)}`)
    if (doorUpper.getProperties) {
      console.log(`  properties: ${JSON.stringify(doorUpper.getProperties())}`)
    }
  } else {
    console.log('Upper door: NOT FOUND')
  }

  // Check surrounding blocks
  console.log('\n=== Surrounding Blocks ===')
  for (let dz = 4; dz <= 6; dz++) {
    for (let dx = -1; dx <= 2; dx++) {
      for (let dy = -1; dy <= 3; dy++) {
        const b = bot.blockAt(new Vec3(BX + dx, BY + dy, BZ + dz))
        if (b && b.name !== 'air') {
          console.log(`  (${BX + dx},${BY + dy},${BZ + dz}): ${b.name} bbox=${b.boundingBox} shapes=${JSON.stringify(b.shapes)}`)
        }
      }
    }
  }

  // Test getBlock with the door fix
  console.log('\n=== Pathfinder getBlock Analysis ===')
  const mov = new Movements(bot)
  const doorBlock = mov.getBlock(new Vec3(BX, BY, BZ + 4), 0, 0, 1)
  console.log(`getBlock for door (WITH fix):`)
  console.log(`  safe=${doorBlock.safe} physical=${doorBlock.physical} openable=${doorBlock.openable}`)
  console.log(`  height=${doorBlock.height} liquid=${doorBlock.liquid} climbable=${doorBlock.climbable}`)

  // Test without fix
  const movOld = new Movements(bot)
  movOld.doorLikeBlocks = new Set()
  const doorBlockOld = movOld.getBlock(new Vec3(BX, BY, BZ + 4), 0, 0, 1)
  console.log(`getBlock for door (WITHOUT fix):`)
  console.log(`  safe=${doorBlockOld.safe} physical=${doorBlockOld.physical} openable=${doorBlockOld.openable}`)

  // Test getMoveForward through the door
  console.log('\n=== getMoveForward through door ===')
  const node = { x: BX, y: BY, z: BZ + 4, remainingBlocks: 0 }
  const dir = { x: 0, z: 1 }

  const neighborsNew = []
  mov.getMoveForward(node, dir, neighborsNew)
  console.log(`WITH fix: ${neighborsNew.length} neighbors generated`)
  for (const n of neighborsNew) {
    console.log(`  Move to (${n.x}, ${n.y}, ${n.z}) cost=${n.cost} toBreak=${n.toBreak.length} toPlace=${n.toPlace.length}`)
  }

  const neighborsOld = []
  movOld.getMoveForward(node, dir, neighborsOld)
  console.log(`WITHOUT fix: ${neighborsOld.length} neighbors generated`)
  for (const n of neighborsOld) {
    console.log(`  Move to (${n.x}, ${n.y}, ${n.z}) cost=${n.cost} toBreak=${n.toBreak.length} toPlace=${n.toPlace.length}`)
  }

  // Now test actual pathfinding through the corridor
  console.log('\n=== Pathfinding Test ===')
  const gx = BX + 0.5, gy = BY, gz = BZ + 10

  // WITH fix
  console.log('\n[A] WITH open door fix:')
  const movA = new Movements(bot)
  movA.canDig = false
  movA.allowSprinting = false
  bot.pathfinder.setMovements(movA)
  await cmd(`/tp @s ${BX + 0.5} ${BY} ${BZ + 0.5}`)
  await sleep(2000)

  const pathA = bot.pathfinder.getPathTo(movA, new GoalNear(gx, gy, gz, 2))
  console.log(`  Path status: ${pathA.status}, nodes: ${pathA.path.length}`)
  for (let i = 0; i < pathA.path.length; i++) {
    const p = pathA.path[i]
    console.log(`  [${i}] (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) toBreak=${p.toBreak.length} toPlace=${p.toPlace.length}`)
  }

  // WITHOUT fix
  console.log('\n[B] WITHOUT open door fix:')
  const movB = new Movements(bot)
  movB.canDig = false
  movB.allowSprinting = false
  movB.doorLikeBlocks = new Set()
  bot.pathfinder.setMovements(movB)

  const pathB = bot.pathfinder.getPathTo(movB, new GoalNear(gx, gy, gz, 2))
  console.log(`  Path status: ${pathB.status}, nodes: ${pathB.path.length}`)
  for (let i = 0; i < pathB.path.length; i++) {
    const p = pathB.path[i]
    console.log(`  [${i}] (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) toBreak=${p.toBreak.length} toPlace=${p.toPlace.length}`)
  }

  // Cleanup
  await cmd(`/fill ${BX - 2} ${BY - 1} ${BZ - 2} ${BX + 4} ${BY + 5} ${BZ + 12} air`)

  bot.quit()
  await sleep(500)
  process.exit(0)
})

function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
bot.on('error', (err) => console.error('[Bot Error]', err.message))
bot.on('kicked', (reason) => { console.error('[Kicked]', JSON.stringify(reason)); process.exit(1) })
