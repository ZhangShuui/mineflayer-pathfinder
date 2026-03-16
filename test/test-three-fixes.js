/**
 * Real-World A/B Test for Three Fixes:
 * 1. Open door passthrough
 * 2. Corner stuck - jump recovery
 * 3. Protected blocks (agent house)
 *
 * Requires a running Minecraft server on localhost:25565 (creative mode, cheats enabled)
 */
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('./index')
const { GoalNear } = goals
const Vec3 = require('vec3')

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'PathBot', version: '1.20.4'
})
bot.loadPlugin(pathfinder)

const BX = 200, BY = 64, BZ = 200

// Anti-spam: MC chat counter += 20/msg, decays 1/tick. At 1100ms between
// commands, decay = 22 > cost = 20 → counter never accumulates.
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

  console.log('\n' + '='.repeat(70))
  console.log('  REAL-WORLD A/B TESTS: Three Fixes')
  console.log('='.repeat(70) + '\n')

  await testOpenDoors()
  await testProtectedBlocks()
  await testCornerStuck()

  console.log('\n' + '='.repeat(70))
  console.log('  ALL TESTS COMPLETE')
  console.log('='.repeat(70))
  bot.quit()
  await sleep(500)
  process.exit(0)
})

// ============================================================
// TEST 1: OPEN DOOR PASSTHROUGH
// ============================================================
async function testOpenDoors () {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  TEST 1: Open Door Passthrough                             ║')
  console.log('╚══════════════════════════════════════════════════════════════╝\n')

  const ox = BX, oy = BY, oz = BZ

  await tp(ox + 1, oy + 5, oz + 7)
  await sleep(3000)

  // Build corridor: 5 commands
  await cmd(`/fill ${ox - 1} ${oy - 1} ${oz - 1} ${ox + 2} ${oy + 4} ${oz + 15} air`)
  await cmd(`/fill ${ox - 1} ${oy - 1} ${oz - 1} ${ox + 2} ${oy - 1} ${oz + 15} stone`)
  await cmd(`/fill ${ox - 1} ${oy} ${oz - 1} ${ox - 1} ${oy + 3} ${oz + 15} stone_bricks`)
  await cmd(`/fill ${ox + 2} ${oy} ${oz - 1} ${ox + 2} ${oy + 3} ${oz + 15} stone_bricks`)
  await cmd(`/fill ${ox - 1} ${oy + 3} ${oz - 1} ${ox + 2} ${oy + 3} ${oz + 15} stone_bricks`)

  // Place doors: 3 commands per door position (wall + lower doors + upper doors)
  for (const dz of [4, 8, 12]) {
    await cmd(`/fill ${ox} ${oy} ${oz + dz} ${ox + 1} ${oy + 2} ${oz + dz} stone_bricks`)
    await cmd(`/fill ${ox} ${oy} ${oz + dz} ${ox + 1} ${oy} ${oz + dz} oak_door[facing=south,half=lower,open=true]`)
    await cmd(`/fill ${ox} ${oy + 1} ${oz + dz} ${ox + 1} ${oy + 1} ${oz + dz} oak_door[facing=south,half=upper,open=true]`)
  }
  await sleep(2000)

  // TP and verify
  await tp(ox + 0.5, oy, oz + 0.5)
  await sleep(3000)

  let openDoors = 0
  for (const dz of [4, 8, 12]) {
    for (const dx of [0, 1]) {
      const b = bot.blockAt(new Vec3(ox + dx, oy, oz + dz))
      if (b && b.name && b.name.includes('door')) {
        const props = b.getProperties ? b.getProperties() : {}
        if (props.open) openDoors++
        console.log(`    Door (${ox + dx},${oy},${oz + dz}): ${b.name} open=${props.open} bbox=${b.boundingBox}`)
      } else {
        console.log(`    (${ox + dx},${oy},${oz + dz}): ${b ? b.name : 'null'} — NOT a door`)
      }
    }
  }
  console.log(`  Total open doors found: ${openDoors}\n`)

  if (openDoors === 0) {
    console.log('  [SKIP] No open doors detected — server may not support /fill with door states\n')
    await cmd(`/fill ${ox - 1} ${oy - 1} ${oz - 1} ${ox + 2} ${oy + 4} ${oz + 15} air`)
    return
  }

  const gx = ox + 0.5, gy = oy, gz = oz + 14

  // A: WITHOUT open door fix
  console.log('  [A] WITHOUT open door fix (doorLikeBlocks disabled):')
  const movOld = new Movements(bot)
  movOld.canDig = false
  movOld.allowSprinting = false
  movOld.doorLikeBlocks = new Set() // disable open door detection
  await tp(ox + 0.5, oy, oz + 0.5)
  const resultA = await runPathTest(bot, movOld, gx, gy, gz, 20000)

  // B: WITH open door fix
  console.log('  [B] WITH open door fix (doorLikeBlocks active):')
  const movNew = new Movements(bot)
  movNew.canDig = false
  movNew.allowSprinting = false
  await tp(ox + 0.5, oy, oz + 0.5)
  const resultB = await runPathTest(bot, movNew, gx, gy, gz, 20000)

  printComparison('Open Door', resultA, resultB)
  await cmd(`/fill ${ox - 1} ${oy - 1} ${oz - 1} ${ox + 2} ${oy + 4} ${oz + 15} air`)
}

// ============================================================
// TEST 2: PROTECTED BLOCKS
// ============================================================
async function testProtectedBlocks () {
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║  TEST 2: Protected Blocks (Agent House)                    ║')
  console.log('╚══════════════════════════════════════════════════════════════╝\n')

  const px = BX + 100, py = BY, pz = BZ

  await tp(px + 1, py + 5, pz + 10)
  await sleep(3000)

  // Build fully enclosed corridor with wall blocking path
  await cmd(`/fill ${px - 1} ${py - 1} ${pz - 1} ${px + 3} ${py + 4} ${pz + 20} air`)
  await cmd(`/fill ${px - 1} ${py - 1} ${pz - 1} ${px + 3} ${py - 1} ${pz + 20} stone`)
  // Left, right walls + ceiling for full enclosure
  await cmd(`/fill ${px - 1} ${py} ${pz - 1} ${px - 1} ${py + 3} ${pz + 20} stone_bricks`)
  await cmd(`/fill ${px + 3} ${py} ${pz - 1} ${px + 3} ${py + 3} ${pz + 20} stone_bricks`)
  await cmd(`/fill ${px - 1} ${py + 3} ${pz - 1} ${px + 3} ${py + 3} ${pz + 20} stone_bricks`)
  // Back wall (start side) and front wall (end side) with openings
  await cmd(`/fill ${px - 1} ${py} ${pz - 1} ${px + 3} ${py + 3} ${pz - 1} stone_bricks`)
  await cmd(`/fill ${px - 1} ${py} ${pz + 20} ${px + 3} ${py + 3} ${pz + 20} stone_bricks`)
  // Openings in back/front walls
  await cmd(`/fill ${px} ${py} ${pz - 1} ${px + 1} ${py + 1} ${pz - 1} air`)
  await cmd(`/fill ${px} ${py} ${pz + 20} ${px + 1} ${py + 1} ${pz + 20} air`)
  // Cross wall blocking the corridor
  await cmd(`/fill ${px} ${py} ${pz + 10} ${px + 2} ${py + 2} ${pz + 10} oak_planks`)
  await sleep(2000)

  const wallBlocks = []
  for (let dx = 0; dx <= 2; dx++) {
    for (let dy = 0; dy <= 2; dy++) {
      wallBlocks.push({ x: px + dx, y: py + dy, z: pz + 10 })
    }
  }

  await tp(px + 1, py, pz + 2)
  await sleep(3000)

  // Verify
  let before = 0
  for (const pos of wallBlocks) {
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
    if (b && b.name === 'oak_planks') before++
  }
  console.log(`  Wall blocks before: ${before}/${wallBlocks.length}\n`)

  const gx = px + 1, gy = py, gz = pz + 18

  // A: WITHOUT protection (canDig=true, should break wall)
  console.log('  [A] WITHOUT block protection (canDig=true):')
  const movA = new Movements(bot)
  movA.canDig = true
  movA.allowSprinting = false
  await tp(px + 1, py, pz + 2)
  const resultA = await runPathTest(bot, movA, gx, gy, gz, 30000)

  let afterA = 0
  for (const pos of wallBlocks) {
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
    if (b && b.name === 'oak_planks') afterA++
  }
  console.log(`    Blocks remaining: ${afterA}/${wallBlocks.length} (${wallBlocks.length - afterA} destroyed)\n`)

  // Rebuild wall
  await cmd(`/fill ${px} ${py} ${pz + 10} ${px + 2} ${py + 2} ${pz + 10} oak_planks`)
  await sleep(2000)

  // B: WITH protection (canDig=true but wall is protected)
  console.log('  [B] WITH block protection (canDig=true + protectBlocks):')
  const movB = new Movements(bot)
  movB.canDig = true
  movB.allowSprinting = false
  movB.protectBlocks(wallBlocks)
  await tp(px + 1, py, pz + 2)
  const resultB = await runPathTest(bot, movB, gx, gy, gz, 15000)

  let afterB = 0
  for (const pos of wallBlocks) {
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
    if (b && b.name === 'oak_planks') afterB++
  }
  console.log(`    Blocks remaining: ${afterB}/${wallBlocks.length} (${wallBlocks.length - afterB} destroyed)`)

  // Summary
  const dA = wallBlocks.length - afterA
  const dB = wallBlocks.length - afterB
  console.log('\n  ┌────────────────┬──────────┬─────────────────┐')
  console.log('  │ Version        │ Status   │ Blocks Destroyed│')
  console.log('  ├────────────────┼──────────┼─────────────────┤')
  console.log(`  │ No protection  │ ${pad(resultA.status, 8)} │ ${pad(dA + '/' + wallBlocks.length, 15)} │`)
  console.log(`  │ protectBlocks  │ ${pad(resultB.status, 8)} │ ${pad(dB + '/' + wallBlocks.length, 15)} │`)
  console.log('  └────────────────┴──────────┴─────────────────┘')
  if (dA > 0 && dB === 0) console.log(`  ★ Protection EFFECTIVE: A broke ${dA}, B broke 0`)
  else if (dB > 0) console.log(`  ✗ Protection FAILED: B still broke ${dB}`)
  else console.log(`  ○ A also didn't break anything (found alternate route)`)
  console.log()

  await cmd(`/fill ${px - 1} ${py - 1} ${pz - 1} ${px + 3} ${py + 4} ${pz + 20} air`)
}

// ============================================================
// TEST 3: CORNER STUCK - JUMP RECOVERY
// ============================================================
async function testCornerStuck () {
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║  TEST 3: Corner Stuck - Jump Recovery                      ║')
  console.log('╚══════════════════════════════════════════════════════════════╝\n')

  const cx = BX + 50, cy = BY, cz = BZ

  await tp(cx + 3, cy + 5, cz + 15)
  await sleep(3000)

  // Build zig-zag: just floor + protruding blocks
  await cmd(`/fill ${cx - 2} ${cy - 1} ${cz - 2} ${cx + 8} ${cy + 4} ${cz + 30} air`)
  await cmd(`/fill ${cx - 2} ${cy - 1} ${cz - 2} ${cx + 8} ${cy - 1} ${cz + 30} stone`)

  // Left and right walls with protruding corners
  await cmd(`/fill ${cx - 1} ${cy} ${cz} ${cx - 1} ${cy + 2} ${cz + 28} stone_bricks`)
  await cmd(`/fill ${cx + 5} ${cy} ${cz} ${cx + 5} ${cy + 2} ${cz + 28} stone_bricks`)

  // Protruding slabs creating tight corners
  for (let dz = 3; dz < 27; dz += 5) {
    await cmd(`/setblock ${cx} ${cy} ${cz + dz} stone_slab[type=bottom]`)
    await cmd(`/setblock ${cx + 4} ${cy} ${cz + dz + 2} stone_slab[type=bottom]`)
  }
  await sleep(2000)

  await tp(cx + 2, cy, cz + 0.5)
  await sleep(3000)

  const gx = cx + 2, gy = cy, gz = cz + 27

  // Run 3 trials and track corner jump events
  const results = []
  for (let trial = 0; trial < 3; trial++) {
    console.log(`  --- Trial ${trial + 1}/3 ---`)
    const mov = new Movements(bot)
    mov.canDig = false
    mov.allowSprinting = true
    await tp(cx + 2, cy, cz + 0.5)
    const r = await runPathTestWithCornerTracking(bot, mov, gx, gy, gz, 25000)
    results.push(r)
  }

  const avg = averageResults(results)
  console.log('\n  ┌──────────────┬──────────┬──────────┬──────────┬────────────┐')
  console.log('  │ Corner test  │ Pass Rate│ Avg Time │ Resets   │ CornerJmps │')
  console.log('  ├──────────────┼──────────┼──────────┼──────────┼────────────┤')
  console.log(`  │ With fix     │ ${pad(avg.passRate, 8)} │ ${pad(avg.avgTime + 's', 8)} │ ${pad(avg.avgResets, 8)} │ ${pad(avg.avgCornerJumps, 10)} │`)
  console.log('  └──────────────┴──────────┴──────────┴──────────┴────────────┘')

  await cmd(`/fill ${cx - 2} ${cy - 1} ${cz - 2} ${cx + 8} ${cy + 4} ${cz + 30} air`)
}

// ============================================================
// HELPERS
// ============================================================
async function runPathTest (bot, movements, gx, gy, gz, timeout) {
  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(null)
  await sleep(500)

  let resets = 0, stuck = 0
  const startPos = bot.entity.position.clone()
  const posLog = []

  const resetH = (reason) => { resets++; if (reason === 'stuck') stuck++ }
  const posI = setInterval(() => { if (bot.entity) posLog.push(bot.entity.position.clone()) }, 500)
  bot.on('path_reset', resetH)

  const t0 = Date.now()
  let status = 'PASS', errMsg = ''
  try {
    await Promise.race([
      bot.pathfinder.goto(new GoalNear(gx, gy, gz, 2)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeout))
    ])
  } catch (err) {
    errMsg = err.message || String(err)
    if (errMsg === 'Timeout') {
      status = (posLog.length >= 6 && maxDist(posLog.slice(-6)) < 2) ? 'STUCK' : 'SLOW'
    } else if (errMsg.includes('Path') || errMsg.includes('path') || errMsg.includes('Goal')) {
      status = 'NOPATH'
    } else {
      status = 'ERR'
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  clearInterval(posI)
  bot.removeListener('path_reset', resetH)
  bot.pathfinder.setGoal(null)
  await sleep(500)

  const endPos = bot.entity.position
  const goalDist = endPos.distanceTo(new Vec3(gx, gy, gz)).toFixed(1)
  const moved = startPos.distanceTo(endPos).toFixed(1)
  const icon = status === 'PASS' ? '✓' : '✗'
  console.log(`    ${icon} ${status} ${elapsed}s | stuck=${stuck} resets=${resets} moved=${moved} goalDist=${goalDist}`)

  return { status, time: parseFloat(elapsed), stuck, resets, moved: parseFloat(moved), goalDist: parseFloat(goalDist) }
}

async function runPathTestWithCornerTracking (bot, movements, gx, gy, gz, timeout) {
  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(null)
  await sleep(500)

  let resets = 0, stuck = 0, cornerJumps = 0
  const startPos = bot.entity.position.clone()
  const posLog = []
  let stuckTicks = 0
  let prevPos = null

  const resetH = (reason) => { resets++; if (reason === 'stuck') stuck++ }
  const posI = setInterval(() => { if (bot.entity) posLog.push(bot.entity.position.clone()) }, 500)

  const cornerTracker = () => {
    if (!bot.entity || !bot.entity.onGround || bot.entity.isInWater) {
      stuckTicks = 0; prevPos = null; return
    }
    if (prevPos) {
      const movedSq = bot.entity.position.distanceSquared(prevPos)
      if (movedSq < 0.001 && bot.controlState.forward) {
        stuckTicks++
        if (stuckTicks === 3) cornerJumps++ // count each stuck event once
      } else {
        stuckTicks = 0
      }
    }
    prevPos = bot.entity.position.clone()
  }
  bot.on('physicsTick', cornerTracker)
  bot.on('path_reset', resetH)

  const t0 = Date.now()
  let status = 'PASS', errMsg = ''
  try {
    await Promise.race([
      bot.pathfinder.goto(new GoalNear(gx, gy, gz, 2)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeout))
    ])
  } catch (err) {
    errMsg = err.message || String(err)
    if (errMsg === 'Timeout') {
      status = (posLog.length >= 6 && maxDist(posLog.slice(-6)) < 2) ? 'STUCK' : 'SLOW'
    } else if (errMsg.includes('Path') || errMsg.includes('path') || errMsg.includes('Goal')) {
      status = 'NOPATH'
    } else {
      status = 'ERR'
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  clearInterval(posI)
  bot.removeListener('physicsTick', cornerTracker)
  bot.removeListener('path_reset', resetH)
  bot.pathfinder.setGoal(null)
  await sleep(500)

  const endPos = bot.entity.position
  const goalDist = endPos.distanceTo(new Vec3(gx, gy, gz)).toFixed(1)
  const moved = startPos.distanceTo(endPos).toFixed(1)
  const icon = status === 'PASS' ? '✓' : '✗'
  console.log(`    ${icon} ${status} ${elapsed}s | stuck=${stuck} resets=${resets} cornerJumps=${cornerJumps} moved=${moved} goalDist=${goalDist}`)

  return { status, time: parseFloat(elapsed), stuck, resets, cornerJumps, moved: parseFloat(moved), goalDist: parseFloat(goalDist) }
}

function printComparison (name, resultA, resultB) {
  console.log(`\n  ┌────────────────┬──────────┬──────────┬──────────┬───────────┐`)
  console.log(`  │ ${pad(name, 14)} │ Status   │ Time     │ Resets   │ GoalDist  │`)
  console.log(`  ├────────────────┼──────────┼──────────┼──────────┼───────────┤`)
  console.log(`  │ WITHOUT fix    │ ${pad(resultA.status, 8)} │ ${pad(resultA.time + 's', 8)} │ ${pad(resultA.resets, 8)} │ ${pad(resultA.goalDist, 9)} │`)
  console.log(`  │ WITH fix       │ ${pad(resultB.status, 8)} │ ${pad(resultB.time + 's', 8)} │ ${pad(resultB.resets, 8)} │ ${pad(resultB.goalDist, 9)} │`)
  console.log(`  └────────────────┴──────────┴──────────┴──────────┴───────────┘`)
  if (resultA.status !== 'PASS' && resultB.status === 'PASS') {
    console.log(`  ★ Fix EFFECTIVE: old=${resultA.status}, new=PASS`)
  } else if (resultA.status === 'PASS' && resultB.status === 'PASS') {
    console.log(`  ✓ Both pass${resultB.time < resultA.time ? ` (new faster: ${resultA.time}s → ${resultB.time}s)` : ''}`)
  } else if (resultA.status === 'PASS' && resultB.status !== 'PASS') {
    console.log(`  ✗ REGRESSION: old=PASS, new=${resultB.status}`)
  } else {
    console.log(`  ○ Both fail: old=${resultA.status}, new=${resultB.status}`)
  }
  console.log()
}

function averageResults (runs) {
  const passes = runs.filter(r => r.status === 'PASS').length
  const n = runs.length
  return {
    passRate: passes + '/' + n,
    avgTime: (runs.reduce((s, r) => s + r.time, 0) / n).toFixed(1),
    avgResets: (runs.reduce((s, r) => s + r.resets, 0) / n).toFixed(1),
    avgCornerJumps: (runs.reduce((s, r) => s + (r.cornerJumps || 0), 0) / n).toFixed(1)
  }
}

function maxDist (positions) {
  let m = 0
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      m = Math.max(m, positions[i].distanceTo(positions[j]))
    }
  }
  return m
}

async function tp (x, y, z) {
  bot.pathfinder.setGoal(null)
  await sleep(300)
  await cmd(`/tp @s ${x} 300 ${z}`)
  await cmd(`/tp @s ${x} ${y} ${z}`)
  await sleep(1500)
}

function pad (v, n) { return String(v).padEnd(n) }
function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

bot.on('error', (err) => console.error('[Bot Error]', err.message))
bot.on('kicked', (reason) => {
  console.error('[Kicked]', JSON.stringify(reason))
  process.exit(1)
})
