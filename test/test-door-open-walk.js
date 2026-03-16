/**
 * Test: bot walks through CLOSED door (must open it, then continue walking)
 * This specifically tests the useOne/placing bug fix.
 * Run 3 trials to verify reliability.
 */
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('./index')
const { GoalNear } = goals
const Vec3 = require('vec3')

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'PathBot', version: '1.20.4'
})
bot.loadPlugin(pathfinder)

const BX = 200, BY = 64, BZ = 350

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
  await cmd('/gamemode survival')
  await sleep(2000)

  console.log('\n' + '='.repeat(70))
  console.log('  TEST: Walk through CLOSED door (useOne placing bug)')
  console.log('='.repeat(70) + '\n')

  const trials = 3
  let passed = 0

  for (let t = 1; t <= trials; t++) {
    console.log(`\n--- Trial ${t}/${trials} ---`)

    // Build corridor with closed door
    await tp(BX + 1, BY + 5, BZ + 7)
    await sleep(2000)
    await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY + 4} ${BZ + 15} air`)
    await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY - 1} ${BZ + 15} stone`)
    await cmd(`/fill ${BX - 1} ${BY} ${BZ - 1} ${BX - 1} ${BY + 3} ${BZ + 15} stone_bricks`)
    await cmd(`/fill ${BX + 2} ${BY} ${BZ - 1} ${BX + 2} ${BY + 3} ${BZ + 15} stone_bricks`)
    await cmd(`/fill ${BX - 1} ${BY + 3} ${BZ - 1} ${BX + 2} ${BY + 3} ${BZ + 15} stone_bricks`)
    // Cross wall + closed door
    await cmd(`/fill ${BX} ${BY} ${BZ + 5} ${BX + 1} ${BY + 2} ${BZ + 5} stone_bricks`)
    await cmd(`/setblock ${BX} ${BY} ${BZ + 5} oak_door[facing=south,half=lower,hinge=left,open=false]`)
    await cmd(`/setblock ${BX} ${BY + 1} ${BZ + 5} oak_door[facing=south,half=upper,hinge=left,open=false]`)
    await sleep(1500)

    // Switch to survival and tp to start
    await cmd('/gamemode survival')
    await tp(BX + 0.5, BY, BZ + 1)
    await sleep(3000)

    // Verify door is closed
    const doorBlock = bot.blockAt(new Vec3(BX, BY, BZ + 5))
    const props = doorBlock && doorBlock.getProperties ? doorBlock.getProperties() : {}
    console.log(`  Door: ${doorBlock ? doorBlock.name : 'null'} open=${props.open}`)

    // Navigate through
    const mov = new Movements(bot)
    mov.canDig = false
    mov.canOpenDoors = true
    mov.allowSprinting = false
    bot.pathfinder.setMovements(mov)

    const gx = BX + 0.5, gy = BY, gz = BZ + 12
    const t0 = Date.now()
    let resetCount = 0
    const resetH = () => { resetCount++ }
    bot.on('path_reset', resetH)

    let status = 'PASS'
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(gx, gy, gz, 2)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 20000))
      ])
    } catch (err) {
      status = err.message === 'Timeout' ? 'TIMEOUT' : 'ERR'
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    bot.removeListener('path_reset', resetH)
    bot.pathfinder.setGoal(null)
    await sleep(500)

    const endPos = bot.entity.position
    const goalDist = endPos.distanceTo(new Vec3(gx, gy, gz)).toFixed(1)
    const crossedDoor = endPos.z > BZ + 5

    const icon = (status === 'PASS' && crossedDoor) ? '✓' : '✗'
    console.log(`  ${icon} ${status} ${elapsed}s | resets=${resetCount} goalDist=${goalDist} crossedDoor=${crossedDoor}`)

    if (status === 'PASS' && crossedDoor) passed++

    // Check door ended up open
    const doorAfter = bot.blockAt(new Vec3(BX, BY, BZ + 5))
    const propsAfter = doorAfter && doorAfter.getProperties ? doorAfter.getProperties() : {}
    console.log(`  Door after: open=${propsAfter.open}`)

    // Cleanup - switch back to creative
    await cmd('/gamemode creative')
    await cmd(`/fill ${BX - 1} ${BY - 1} ${BZ - 1} ${BX + 2} ${BY + 4} ${BZ + 15} air`)
  }

  console.log(`\n${'='.repeat(70)}`)
  console.log(`  RESULT: ${passed}/${trials} passed`)
  console.log(`${'='.repeat(70)}`)

  bot.quit()
  await sleep(500)
  process.exit(passed === trials ? 0 : 1)
})

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
