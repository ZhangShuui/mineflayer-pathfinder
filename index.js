const { performance } = require('perf_hooks')

const AStar = require('./lib/astar')
const Move = require('./lib/move')
const Movements = require('./lib/movements')
const gotoUtil = require('./lib/goto')
const Lock = require('./lib/lock')

const Vec3 = require('vec3').Vec3

const Physics = require('./lib/physics')
const nbt = require('prismarine-nbt')
const interactableBlocks = require('./lib/interactable.json')

function inject (bot) {
  const waterType = bot.registry.blocksByName.water.id
  const ladderId = bot.registry.blocksByName.ladder.id
  const vineId = bot.registry.blocksByName.vine.id
  let stateMovements = new Movements(bot)
  let stateGoal = null
  let astarContext = null
  let astartTimedout = false
  let dynamicGoal = false
  let path = []
  let pathIdx = 0
  let pathUpdated = false
  let digging = false
  let placing = false
  let placingBlock = null
  let lastNodeTime = performance.now()
  let lastNodePos = null // position when lastNodeTime was last updated
  let returningPos = null
  let stopPathing = false
  let stuckCount = 0 // consecutive stucks without meaningful progress toward goal
  let lastGoalDistAtStuck = null
  let straightLineCache = null // { pathHead: Move, sprint: bool|null, result: string }
  // result: 'sprintLine', 'sprintJump', 'walkLine', 'walkJump', 'none'
  let cornerStuckTicks = 0
  let lastMonitorPos = null
  const physics = new Physics(bot)
  const lockPlaceBlock = new Lock()
  const lockEquipItem = new Lock()
  const lockUseBlock = new Lock()

  bot.pathfinder = {}

  bot.pathfinder.thinkTimeout = 5000 // ms
  bot.pathfinder.tickTimeout = 40 // ms, amount of thinking per tick (max 50 ms)
  bot.pathfinder.searchRadius = -1 // in blocks, limits of the search area, -1: don't limit the search
  bot.pathfinder.enablePathShortcut = false // disabled by default as it can cause bugs in specific configurations
  bot.pathfinder.LOSWhenPlacingBlocks = true

  const harvestToolCache = new Map()

  bot.pathfinder.bestHarvestTool = (block) => {
    const cached = harvestToolCache.get(block.type)
    if (cached !== undefined) return cached

    const availableTools = bot.inventory.items()
    const effects = bot.entity.effects

    let fastest = Number.MAX_VALUE
    let bestTool = null
    for (const tool of availableTools) {
      const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : []
      const digTime = block.digTime(tool ? tool.type : null, false, false, false, enchants, effects)
      if (digTime < fastest) {
        fastest = digTime
        bestTool = tool
      }
    }

    harvestToolCache.set(block.type, bestTool)
    return bestTool
  }

  bot.pathfinder.clearHarvestToolCache = () => harvestToolCache.clear()

  bot.pathfinder.getPathTo = (movements, goal, timeout) => {
    const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout })
    const { value: { result, astarContext: context } } = generator.next()
    astarContext = context
    return result
  }

  bot.pathfinder.getPathFromTo = function * (movements, startPos, goal, options = {}) {
    const optimizePath = options.optimizePath ?? true
    const resetEntityIntersects = options.resetEntityIntersects ?? true
    const timeout = options.timeout ?? bot.pathfinder.thinkTimeout
    const tickTimeout = options.tickTimeout ?? bot.pathfinder.tickTimeout
    const searchRadius = options.searchRadius ?? bot.pathfinder.searchRadius
    let start
    if (options.startMove) {
      start = options.startMove
    } else {
      const p = startPos.floored()
      const dy = startPos.y - p.y
      const b = bot.blockAt(p) // The block we are standing in
      // Offset the floored bot position by one if we are standing on a block that has not the full height but is solid
      const offset = (b && dy > 0.001 && bot.entity.onGround && !stateMovements.emptyBlocks.has(b.type)) ? 1 : 0
      start = new Move(p.x, p.y + offset, p.z, movements.countScaffoldingItems(), 0)
    }
    if (movements.allowEntityDetection) {
      if (resetEntityIntersects) {
        movements.clearCollisionIndex()
      }
      movements.updateCollisionIndex()
    }
    const astarContext = new AStar(start, movements, goal, timeout, tickTimeout, searchRadius)
    let result = astarContext.compute()
    if (optimizePath) result.path = postProcessPath(result.path)
    yield { result, astarContext }
    while (result.status === 'partial') {
      result = astarContext.compute()
      if (optimizePath) result.path = postProcessPath(result.path)
      yield { result, astarContext }
    }
  }

  Object.defineProperties(bot.pathfinder, {
    goal: {
      get () {
        return stateGoal
      }
    },
    movements: {
      get () {
        return stateMovements
      }
    }
  })

  function detectDiggingStopped () {
    digging = false
    bot.removeListener('diggingAborted', detectDiggingStopped)
    bot.removeListener('diggingCompleted', detectDiggingStopped)
  }

  function resetPath (reason, clearStates = true) {
    if (!stopPathing && pathIdx < path.length) bot.emit('path_reset', reason)
    path = []
    pathIdx = 0
    straightLineCache = null
    cornerStuckTicks = 0
    lastMonitorPos = null
    if (digging) {
      bot.on('diggingAborted', detectDiggingStopped)
      bot.on('diggingCompleted', detectDiggingStopped)
      bot.stopDigging()
    }
    placing = false
    pathUpdated = false
    astarContext = null
    lockEquipItem.release()
    lockPlaceBlock.release()
    lockUseBlock.release()
    stateMovements.clearCollisionIndex()
    if (clearStates) bot.clearControlStates()
    if (stopPathing) return stop()
  }

  bot.pathfinder.setGoal = (goal, dynamic = false) => {
    stateGoal = goal
    dynamicGoal = dynamic
    stuckCount = 0
    lastGoalDistAtStuck = null
    lastNodePos = null
    harvestToolCache.clear()
    bot.emit('goal_updated', goal, dynamic)
    resetPath('goal_updated')
  }

  bot.pathfinder.setMovements = (movements) => {
    stateMovements = movements
    resetPath('movements_updated')
  }

  bot.pathfinder.isMoving = () => pathIdx < path.length
  bot.pathfinder.isMining = () => digging
  bot.pathfinder.isBuilding = () => placing

  bot.pathfinder.goto = (goal) => {
    return gotoUtil(bot, goal)
  }

  bot.pathfinder.stop = () => {
    stopPathing = true
  }

  /**
   * Load structure protection from a directory containing blueprint.json and struct_*.json.
   * Protected blocks will persist across setMovements() calls.
   * @param {string} dirPath Path to the data directory
   * @param {function} [filter] Optional filter (structure) => boolean, defaults to agent houses
   * @returns {number} Number of protected block positions added
   */
  let protectionDir = null
  let protectionFilter = null
  bot.pathfinder.loadStructureProtection = (dirPath, filter) => {
    protectionDir = dirPath
    protectionFilter = filter || (s => s.id.startsWith('agent_house_'))
    const added = stateMovements.loadProtectedStructuresFromDir(protectionDir, protectionFilter)
    return added
  }

  // Re-apply protection when movements are replaced
  const origSetMovements = bot.pathfinder.setMovements
  bot.pathfinder.setMovements = (movements) => {
    if (protectionDir) {
      movements.loadProtectedStructuresFromDir(protectionDir, protectionFilter)
    }
    origSetMovements(movements)
  }

  bot.on('physicsTick', monitorMovement)

  function postProcessPath (path) {
    for (let i = 0; i < path.length; i++) {
      const curPoint = path[i]
      if (curPoint.toBreak.length > 0 || curPoint.toPlace.length > 0) break
      const b = bot.blockAt(new Vec3(curPoint.x, curPoint.y, curPoint.z))
      if (b && (b.type === waterType || ((b.type === ladderId || b.type === vineId) && i + 1 < path.length && path[i + 1].y < curPoint.y))) {
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = Math.floor(curPoint.y)
        curPoint.z = Math.floor(curPoint.z) + 0.5
        continue
      }
      // Open doors/gates/trapdoors: treat as air (don't stand on them)
      if (b && stateMovements.doorLikeBlocks.has(b.type) && b.getProperties) {
        const props = b.getProperties()
        if (props && props.open) {
          const below = bot.blockAt(new Vec3(curPoint.x, curPoint.y - 1, curPoint.z))
          const np2 = getPositionOnTopOf(below)
          if (np2) {
            curPoint.x = np2.x
            curPoint.y = np2.y
            curPoint.z = np2.z
          } else {
            curPoint.x = Math.floor(curPoint.x) + 0.5
            curPoint.y = curPoint.y - 1
            curPoint.z = Math.floor(curPoint.z) + 0.5
          }
          continue
        }
      }
      let np = getPositionOnTopOf(b)
      if (np === null) np = getPositionOnTopOf(bot.blockAt(new Vec3(curPoint.x, curPoint.y - 1, curPoint.z)))
      if (np) {
        curPoint.x = np.x
        curPoint.y = np.y
        curPoint.z = np.z
      } else {
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = curPoint.y - 1
        curPoint.z = Math.floor(curPoint.z) + 0.5
      }
    }

    if (!bot.pathfinder.enablePathShortcut || stateMovements.exclusionAreasStep.length !== 0 || path.length === 0) return path

    const newPath = []
    let lastNode = bot.entity.position
    for (let i = 1; i < path.length; i++) {
      const node = path[i]
      if (Math.abs(node.y - lastNode.y) > 0.5 || node.toBreak.length > 0 || node.toPlace.length > 0 || !physics.canStraightLineBetween(lastNode, node)) {
        newPath.push(path[i - 1])
        lastNode = path[i - 1]
      }
    }
    newPath.push(path[path.length - 1])
    return newPath
  }

  function pathFromPlayer (p) {
    if (p.length === 0) return 0
    let minI = 0
    let minDistance = 1000
    for (let i = 0; i < p.length; i++) {
      const node = p[i]
      if (node.toBreak.length !== 0 || node.toPlace.length !== 0) break
      const dist = bot.entity.position.distanceSquared(node)
      if (dist < minDistance) {
        minDistance = dist
        minI = i
      }
    }
    // check if we are between 2 nodes
    const n1 = p[minI]
    // check if node already reached
    const dx = n1.x - bot.entity.position.x
    const dy = n1.y - bot.entity.position.y
    const dz = n1.z - bot.entity.position.z
    const reached = Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < 1
    if (minI + 1 < p.length && n1.toBreak.length === 0 && n1.toPlace.length === 0) {
      const n2 = p[minI + 1]
      const d2 = bot.entity.position.distanceSquared(n2)
      const d12 = n1.distanceSquared(n2)
      minI += d12 > d2 || reached ? 1 : 0
    }

    return minI
  }

  function isPositionNearPath (pos, path) {
    let prevNode = null
    for (const node of path) {
      let comparisonPoint = null
      if (
        prevNode === null ||
        (
          Math.abs(prevNode.x - node.x) <= 2 &&
          Math.abs(prevNode.y - node.y) <= 2 &&
          Math.abs(prevNode.z - node.z) <= 2
        )
      ) {
        // Unoptimized path, or close enough to last point
        // to just check against the current point
        comparisonPoint = node
      } else {
        // Optimized path - the points are far enough apart
        //   that we need to check the space between them too

        // First, a quick check - if point it outside the path
        // segment's AABB, then it isn't near.
        const minBound = prevNode.min(node)
        const maxBound = prevNode.max(node)
        if (
          pos.x - 0.5 < minBound.x - 1 ||
          pos.x - 0.5 > maxBound.x + 1 ||
          pos.y - 0.5 < minBound.y - 2 ||
          pos.y - 0.5 > maxBound.y + 2 ||
          pos.z - 0.5 < minBound.z - 1 ||
          pos.z - 0.5 > maxBound.z + 1
        ) {
          continue
        }

        comparisonPoint = closestPointOnLineSegment(pos, prevNode, node)
      }

      const dx = Math.abs(comparisonPoint.x - pos.x - 0.5)
      const dy = Math.abs(comparisonPoint.y - pos.y - 0.5)
      const dz = Math.abs(comparisonPoint.z - pos.z - 0.5)
      if (dx <= 1 && dy <= 2 && dz <= 1) return true

      prevNode = node
    }

    return false
  }

  function closestPointOnLineSegment (point, segmentStart, segmentEnd) {
    const segment = segmentEnd.minus(segmentStart)
    const segmentLengthSq = segment.dot(segment)

    if (segmentLengthSq === 0) {
      return segmentStart
    }

    // t is like an interpolation from segmentStart to segmentEnd
    //  for the closest point on the line
    let t = (point.minus(segmentStart)).dot(segment) / segmentLengthSq

    // bound t to be on the segment
    t = Math.max(0, Math.min(1, t))

    return segmentStart.plus(segmentEnd.minus(segmentStart).scaled(t))
  }

  // Return the average x/z position of the highest standing positions
  // in the block.
  function getPositionOnTopOf (block) {
    if (!block || block.shapes.length === 0) return null
    const p = new Vec3(0.5, 0, 0.5)
    let n = 1
    for (const shape of block.shapes) {
      const h = shape[4]
      if (h === p.y) {
        p.x += (shape[0] + shape[3]) / 2
        p.z += (shape[2] + shape[5]) / 2
        n++
      } else if (h > p.y) {
        n = 2
        p.x = 0.5 + (shape[0] + shape[3]) / 2
        p.y = h
        p.z = 0.5 + (shape[2] + shape[5]) / 2
      }
    }
    p.x /= n
    p.z /= n
    return block.position.plus(p)
  }

  /**
   * Stop the bot's movement and recenter to the center off the block when the bot's hitbox is partially beyond the
   * current blocks dimensions.
   */
  function fullStop () {
    bot.clearControlStates()

    // Force horizontal velocity to 0 (otherwise inertia can move us too far)
    // Kind of cheaty, but the server will not tell the difference
    bot.entity.velocity.x = 0
    bot.entity.velocity.z = 0

    const blockX = Math.floor(bot.entity.position.x) + 0.5
    const blockZ = Math.floor(bot.entity.position.z) + 0.5

    // Make sure our bounding box don't collide with neighboring blocks
    // otherwise recenter the position
    if (Math.abs(bot.entity.position.x - blockX) > 0.2) { bot.entity.position.x = blockX }
    if (Math.abs(bot.entity.position.z - blockZ) > 0.2) { bot.entity.position.z = blockZ }
  }

  function moveToEdge (refBlock, edge) {
    // If allowed turn instantly should maybe be a bot option
    const allowInstantTurn = false
    function getViewVector (pitch, yaw) {
      const csPitch = Math.cos(pitch)
      const snPitch = Math.sin(pitch)
      const csYaw = Math.cos(yaw)
      const snYaw = Math.sin(yaw)
      return new Vec3(-snYaw * csPitch, snPitch, -csYaw * csPitch)
    }
    // Target viewing direction while approaching edge
    // The Bot approaches the edge while looking in the opposite direction from where it needs to go
    // The target Pitch angle is roughly the angle the bot has to look down for when it is in the position
    // to place the next block
    const targetBlockPos = refBlock.offset(edge.x + 0.5, edge.y, edge.z + 0.5)
    const targetPosDelta = bot.entity.position.clone().subtract(targetBlockPos)
    const targetYaw = Math.atan2(-targetPosDelta.x, -targetPosDelta.z)
    const targetPitch = -1.421
    const viewVector = getViewVector(targetPitch, targetYaw)
    // While the bot is not in the right position rotate the view and press back while crouching
    if (bot.entity.position.distanceTo(refBlock.clone().offset(edge.x + 0.5, 1, edge.z + 0.5)) > 0.4) {
      bot.lookAt(bot.entity.position.offset(viewVector.x, viewVector.y, viewVector.z), allowInstantTurn)
      bot.setControlState('sneak', true)
      bot.setControlState('back', true)
      return false
    }
    bot.setControlState('back', false)
    return true
  }

  function moveToBlock (pos) {
    // minDistanceSq = Min distance sqrt to the target pos were the bot is centered enough to place blocks around him
    const minDistanceSq = 0.2 * 0.2
    const targetPos = pos.clone().offset(0.5, 0, 0.5)
    if (bot.entity.position.distanceSquared(targetPos) > minDistanceSq) {
      bot.lookAt(targetPos)
      bot.setControlState('forward', true)
      return false
    }
    bot.setControlState('forward', false)
    return true
  }

  function stop () {
    stopPathing = false
    stateGoal = null
    path = []
    pathIdx = 0
    bot.emit('path_stop')
    fullStop()
  }

  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!oldBlock || !newBlock) return
    if (isPositionNearPath(oldBlock.position, path) && oldBlock.type !== newBlock.type) {
      resetPath('block_updated', false)
    }
  })

  bot.on('chunkColumnLoad', (chunk) => {
    // Reset only if the new chunk is adjacent to a visited chunk
    if (astarContext) {
      const cx = chunk.x >> 4
      const cz = chunk.z >> 4
      if (astarContext.visitedChunks.has((cx - 1) * 67108864 + cz) ||
          astarContext.visitedChunks.has(cx * 67108864 + (cz - 1)) ||
          astarContext.visitedChunks.has((cx + 1) * 67108864 + cz) ||
          astarContext.visitedChunks.has(cx * 67108864 + (cz + 1))) {
        resetPath('chunk_loaded', false)
      }
    }
  })

  function monitorMovement () {
    if (!stateGoal && pathIdx >= path.length && !astarContext) return
    // Test freemotion
    if (stateMovements && stateMovements.allowFreeMotion && stateGoal && stateGoal.entity) {
      const target = stateGoal.entity
      if (physics.canStraightLine([target.position])) {
        bot.lookAt(target.position.offset(0, 1.6, 0))

        if (target.position.distanceSquared(bot.entity.position) > stateGoal.rangeSq) {
          bot.setControlState('forward', true)
        } else {
          bot.clearControlStates()
        }
        return
      }
    }
    if (stateGoal) {
      if (!stateGoal.isValid()) {
        stop()
      } else if (stateGoal.hasChanged()) {
        resetPath('goal_moved', false)
      }
    }

    if (astarContext && astartTimedout) {
      const results = astarContext.compute()
      results.path = postProcessPath(results.path)
      const skip = pathFromPlayer(results.path)
      bot.emit('path_update', results)
      path = results.path
      pathIdx = skip
      astartTimedout = results.status === 'partial'
    }

    if (bot.pathfinder.LOSWhenPlacingBlocks && returningPos) {
      if (!moveToBlock(returningPos)) return
      returningPos = null
    }

    if (pathIdx >= path.length) {
      if (stateGoal && stateMovements) {
        if (stateGoal.isEnd(bot.entity.position.floored())) {
          if (!dynamicGoal) {
            bot.emit('goal_reached', stateGoal)
            stateGoal = null
            fullStop()
          }
        } else if (!pathUpdated) {
          lastNodeTime = performance.now()
          lastNodePos = bot.entity.position.clone()
          const results = bot.pathfinder.getPathTo(stateMovements, stateGoal)
          bot.emit('path_update', results)
          path = results.path
          pathIdx = 0
          astartTimedout = results.status === 'partial'
          pathUpdated = true
        } else if (performance.now() - lastNodeTime > 3500) {
          // Path is empty, A* was started (pathUpdated=true) but bot consumed
          // trivial paths without making real spatial progress
          if (handleStuck()) return
        }
      }
    }

    if (pathIdx >= path.length) {
      return
    }

    let nextPoint = path[pathIdx]
    const p = bot.entity.position

    // Handle digging
    if (digging || nextPoint.toBreak.length > 0) {
      if (!digging && bot.entity.onGround) {
        digging = true
        const b = nextPoint.toBreak.shift()
        const block = bot.blockAt(new Vec3(b.x, b.y, b.z), false)
        const tool = bot.pathfinder.bestHarvestTool(block)
        fullStop()

        const digBlock = () => {
          bot.dig(block, true)
            .catch(_ignoreError => {
              resetPath('dig_error')
            })
            .then(function () {
              lastNodeTime = performance.now()
              lastNodePos = bot.entity.position.clone()
              digging = false
            })
        }

        if (!tool) {
          digBlock()
        } else {
          bot.equip(tool, 'hand')
            .catch(_ignoreError => {})
            .then(() => digBlock())
        }
      }
      return
    }
    // Handle block placement
    // TODO: sneak when placing or make sure the block is not interactive
    if (placing || nextPoint.toPlace.length > 0) {
      if (!placing) {
        placing = true
        placingBlock = nextPoint.toPlace.shift()
        fullStop()
      }

      // Open gates or doors
      if (placingBlock?.useOne) {
        if (!lockUseBlock.tryAcquire()) return
        bot.activateBlock(bot.blockAt(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z))).then(() => {
          lockUseBlock.release()
          placingBlock = nextPoint.toPlace.shift()
        }, err => {
          console.error(err)
          lockUseBlock.release()
        })
        return
      }
      const block = stateMovements.getScaffoldingItem()
      if (!block) {
        resetPath('no_scaffolding_blocks')
        return
      }
      if (bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.y === bot.entity.position.floored().y - 1 && placingBlock.dy === 0) {
        if (!moveToEdge(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z), new Vec3(placingBlock.dx, 0, placingBlock.dz))) return
      }
      let canPlace = true
      if (placingBlock.jump) {
        bot.setControlState('jump', true)
        canPlace = placingBlock.y + 1 < bot.entity.position.y
      }
      if (canPlace) {
        if (!lockEquipItem.tryAcquire()) return
        bot.equip(block, 'hand')
          .then(function () {
            lockEquipItem.release()
            const refBlock = bot.blockAt(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z), false)
            if (!lockPlaceBlock.tryAcquire()) return
            if (interactableBlocks.includes(refBlock.name)) {
              bot.setControlState('sneak', true)
            }
            bot.placeBlock(refBlock, new Vec3(placingBlock.dx, placingBlock.dy, placingBlock.dz))
              .then(function () {
                // Dont release Sneak if the block placement was not successful
                bot.setControlState('sneak', false)
                if (bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.returnPos) returningPos = placingBlock.returnPos.clone()
              })
              .catch(_ignoreError => {
                resetPath('place_error')
              })
              .then(() => {
                lockPlaceBlock.release()
                placing = false
                lastNodeTime = performance.now()
                lastNodePos = bot.entity.position.clone()
              })
          })
          .catch(_ignoreError => {})
      }
      return
    }

    let dx = nextPoint.x - p.x
    const dy = nextPoint.y - p.y
    let dz = nextPoint.z - p.z
    if (Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < 1) {
      // arrived at next point — only count as progress if bot actually moved
      if (!lastNodePos || p.distanceTo(lastNodePos) > 0.5) {
        lastNodeTime = performance.now()
        lastNodePos = p.clone()
      }
      if (stopPathing) {
        stop()
        return
      }
      pathIdx++
      if (pathIdx >= path.length) { // done
        // If the block the bot is standing on is not a full block only checking for the floored position can fail as
        // the distance to the goal can get greater then 0 when the vector is floored.
        if (!dynamicGoal && stateGoal && (stateGoal.isEnd(p.floored()) || stateGoal.isEnd(p.floored().offset(0, 1, 0)))) {
          bot.emit('goal_reached', stateGoal)
          stateGoal = null
        }
        fullStop()
        return
      }
      // not done yet
      nextPoint = path[pathIdx]
      if (nextPoint.toBreak.length > 0 || nextPoint.toPlace.length > 0) {
        fullStop()
        return
      }
      dx = nextPoint.x - p.x
      dz = nextPoint.z - p.z
    }

    bot.look(Math.atan2(-dx, -dz), 0)
    bot.setControlState('forward', true)
    bot.setControlState('jump', false)

    if (bot.entity.isInWater) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', false)
    } else {
      // Cache physics simulation results — invalidated when path head changes
      const pathHead = path[pathIdx]
      if (!straightLineCache || straightLineCache.pathHead !== pathHead) {
        const activePath = pathIdx > 0 ? path.slice(pathIdx) : path
        let result = 'none'
        if (stateMovements.allowSprinting && physics.canStraightLine(activePath, true)) {
          result = 'sprintLine'
        } else if (stateMovements.allowSprinting && physics.canSprintJump(activePath)) {
          result = 'sprintJump'
        } else if (physics.canStraightLine(activePath)) {
          result = 'walkLine'
        } else if (physics.canWalkJump(activePath)) {
          result = 'walkJump'
        }
        straightLineCache = { pathHead, result }
      }
      switch (straightLineCache.result) {
        case 'sprintLine':
          bot.setControlState('jump', false)
          bot.setControlState('sprint', true)
          break
        case 'sprintJump':
          bot.setControlState('jump', true)
          bot.setControlState('sprint', true)
          break
        case 'walkLine':
          bot.setControlState('jump', false)
          bot.setControlState('sprint', false)
          break
        case 'walkJump':
          bot.setControlState('jump', true)
          bot.setControlState('sprint', false)
          break
        default:
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
      }
    }

    // Corner-stuck recovery: if on ground, pressing forward, but barely moving
    if (bot.entity.onGround && bot.controlState.forward && !bot.entity.isInWater) {
      if (lastMonitorPos) {
        const movedSq = bot.entity.position.distanceSquared(lastMonitorPos)
        if (movedSq < 0.001) {
          cornerStuckTicks++
          if (cornerStuckTicks >= 3) {
            bot.setControlState('jump', true)
          }
        } else {
          cornerStuckTicks = 0
        }
      }
      lastMonitorPos = bot.entity.position.clone()
    } else {
      cornerStuckTicks = 0
      lastMonitorPos = null
    }

    // check for futility
    if (performance.now() - lastNodeTime > 3500) {
      handleStuck()
    }
  }

  /**
   * Handles stuck detection. Returns true if the goal was abandoned (noPath).
   */
  function handleStuck () {
    if (stateGoal) {
      const currentDist = stateGoal.heuristic(bot.entity.position.floored())
      if (lastGoalDistAtStuck !== null && currentDist >= lastGoalDistAtStuck - 2) {
        // Not making meaningful progress toward goal
        stuckCount++
      } else {
        stuckCount = 0
      }
      lastGoalDistAtStuck = currentDist
    } else {
      stuckCount++
    }

    if (stuckCount >= 3) {
      // Stuck too many times without meaningful progress toward goal
      stuckCount = 0
      lastGoalDistAtStuck = null
      bot.emit('path_update', { status: 'noPath', path: [], visitedNodes: 0, time: 0 })
      stateGoal = null
      fullStop()
      return true
    }
    resetPath('stuck')
    return false
  }
}

module.exports = {
  pathfinder: inject,
  Movements: require('./lib/movements'),
  goals: require('./lib/goals')
}
