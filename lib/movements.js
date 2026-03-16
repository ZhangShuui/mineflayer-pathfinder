const { Vec3 } = require('vec3')
const nbt = require('prismarine-nbt')
const fs = require('fs')
const path = require('path')
const Move = require('./move')

const tmpVec = new Vec3(0, 0, 0)
const NULL_BLOCK = Object.freeze({
  replaceable: false,
  canFall: false,
  safe: false,
  physical: false,
  liquid: false,
  climbable: false,
  height: 0,
  openable: false,
  position: null
})

const cardinalDirections = [
  { x: -1, z: 0 }, // West
  { x: 1, z: 0 }, // East
  { x: 0, z: -1 }, // North
  { x: 0, z: 1 } // South
]
const diagonalDirections = [
  { x: -1, z: -1 },
  { x: -1, z: 1 },
  { x: 1, z: -1 },
  { x: 1, z: 1 }
]

class Movements {
  constructor (bot) {
    const registry = bot.registry
    this.bot = bot

    this.canDig = true
    this.digCost = 1
    this.placeCost = 1
    this.liquidCost = 1
    this.entityCost = 1

    this.dontCreateFlow = true
    this.dontMineUnderFallingBlock = true
    this.allow1by1towers = true
    this.allowFreeMotion = false
    this.allowParkour = true
    this.allowSprinting = true
    this.allowEntityDetection = true
    this.allowBreakLeaves = true

    this.entitiesToAvoid = new Set()
    this.passableEntities = new Set(require('./passableEntities.json'))
    this.interactableBlocks = new Set(require('./interactable.json'))

    this.blocksCantBreak = new Set()
    this.blocksCantBreak.add(registry.blocksByName.chest.id)

    registry.blocksArray.forEach(block => {
      if (block.diggable) return
      this.blocksCantBreak.add(block.id)
    })

    this.blocksToAvoid = new Set()
    this.blocksToAvoid.add(registry.blocksByName.fire.id)
    if (registry.blocksByName.cobweb) this.blocksToAvoid.add(registry.blocksByName.cobweb.id)
    if (registry.blocksByName.web) this.blocksToAvoid.add(registry.blocksByName.web.id)
    this.blocksToAvoid.add(registry.blocksByName.lava.id)

    this.liquids = new Set()
    this.liquids.add(registry.blocksByName.water.id)
    this.liquids.add(registry.blocksByName.lava.id)

    this.gravityBlocks = new Set()
    this.gravityBlocks.add(registry.blocksByName.sand.id)
    this.gravityBlocks.add(registry.blocksByName.gravel.id)

    this.climbables = new Set()
    this.climbables.add(registry.blocksByName.ladder.id)
    // this.climbables.add(registry.blocksByName.vine.id)
    this.emptyBlocks = new Set()

    this.replaceables = new Set()
    this.replaceables.add(registry.blocksByName.air.id)
    if (registry.blocksByName.cave_air) this.replaceables.add(registry.blocksByName.cave_air.id)
    if (registry.blocksByName.void_air) this.replaceables.add(registry.blocksByName.void_air.id)
    this.replaceables.add(registry.blocksByName.water.id)
    this.replaceables.add(registry.blocksByName.lava.id)

    this.scafoldingBlocks = []
    this.scafoldingBlocks.push(registry.itemsByName.dirt.id)
    this.scafoldingBlocks.push(registry.itemsByName.cobblestone.id)

    const Block = require('prismarine-block')(bot.registry)
    this.fences = new Set()
    this.carpets = new Set()
    this.openable = new Set()
    registry.blocksArray.map(x => Block.fromStateId(x.minStateId, 0)).forEach(block => {
      if (block.shapes.length > 0) {
        // Fences or any block taller than 1, they will be considered as non-physical to avoid
        // trying to walk on them
        if (block.shapes[0][4] > 1) this.fences.add(block.type)
        // Carpets or any blocks smaller than 0.1, they will be considered as safe to walk in
        if (block.shapes[0][4] < 0.1) this.carpets.add(block.type)
      } else if (block.shapes.length === 0) {
        this.emptyBlocks.add(block.type)
      }
    })
    this.doorLikeBlocks = new Set()
    registry.blocksArray.forEach(block => {
      const lname = block.name.toLowerCase()
      if (this.interactableBlocks.has(block.name) && !lname.includes('iron')) {
        if (lname.includes('gate') || lname.includes('door')) {
          this.openable.add(block.id)
        }
      }
      const name = block.name.toLowerCase()
      if (name.includes('door') || name.includes('gate')) {
        this.doorLikeBlocks.add(block.id)
      }
    })

    this.canOpenDoors = false // Causes issues. Probably due to none paper servers.

    this._blockCache = new Map()
    this._blockCacheEnabled = false

    this.exclusionAreasStep = []
    this.exclusionAreasBreak = []
    this.exclusionAreasPlace = []
    this.protectedBlockPositions = new Set()

    this.maxDropDown = 4
    this.infiniteLiquidDropdownDistance = true

    this.entityIntersections = {}
  }

  exclusionPlace (block) {
    if (this.exclusionAreasPlace.length === 0) return 0
    let weight = 0
    for (const a of this.exclusionAreasPlace) {
      weight += a(block)
    }
    return weight
  }

  exclusionStep (block) {
    if (this.exclusionAreasStep.length === 0) return 0
    let weight = 0
    for (const a of this.exclusionAreasStep) {
      weight += a(block)
    }
    return weight
  }

  exclusionBreak (block) {
    if (this.exclusionAreasBreak.length === 0) return 0
    let weight = 0
    for (const a of this.exclusionAreasBreak) {
      weight += a(block)
    }
    return weight
  }

  countScaffoldingItems () {
    let count = 0
    const items = this.bot.inventory.items()
    for (const id of this.scafoldingBlocks) {
      for (const j in items) {
        const item = items[j]
        if (item.type === id) count += item.count
      }
    }
    return count
  }

  getScaffoldingItem () {
    const items = this.bot.inventory.items()
    for (const id of this.scafoldingBlocks) {
      for (const j in items) {
        const item = items[j]
        if (item.type === id) return item
      }
    }
    return null
  }

  clearCollisionIndex () {
    this.entityIntersections = {}
  }

  /**
   * Finds blocks intersected by entity bounding boxes
   * and sets the number of ents intersecting in a dict.
   * Ignores entities that do not affect block placement
   */
  updateCollisionIndex () {
    for (const ent of Object.values(this.bot.entities)) {
      if (ent === this.bot.entity) { continue }

      const avoidedEnt = this.entitiesToAvoid.has(ent.name)
      if (avoidedEnt || !this.passableEntities.has(ent.name)) {
        const entSquareRadius = ent.width / 2.0
        const minY = Math.floor(ent.position.y)
        const maxY = Math.ceil(ent.position.y + ent.height)
        const minX = Math.floor(ent.position.x - entSquareRadius)
        const maxX = Math.ceil(ent.position.x + entSquareRadius)
        const minZ = Math.floor(ent.position.z - entSquareRadius)
        const maxZ = Math.ceil(ent.position.z + entSquareRadius)

        const cost = avoidedEnt ? 100 : 1

        for (let y = minY; y < maxY; y++) {
          for (let x = minX; x < maxX; x++) {
            for (let z = minZ; z < maxZ; z++) {
              const key = `${x},${y},${z}`
              this.entityIntersections[key] = (this.entityIntersections[key] ?? 0) + cost
            }
          }
        }
      }
    }
  }

  /**
   * Gets number of entities who's bounding box intersects the node + offset
   * @param {import('vec3').Vec3} pos node position
   * @param {number} dx X axis offset
   * @param {number} dy Y axis offset
   * @param {number} dz Z axis offset
   * @returns {number} Number of entities intersecting block
   */
  getNumEntitiesAt (pos, dx, dy, dz) {
    if (this.allowEntityDetection === false) return 0
    if (!pos) return 0
    const y = pos.y + dy
    const x = pos.x + dx
    const z = pos.z + dz

    return this.entityIntersections[`${x},${y},${z}`] ?? 0
  }

  getBlock (pos, dx, dy, dz) {
    if (!pos) return NULL_BLOCK
    const x = pos.x + dx
    const y = pos.y + dy
    const z = pos.z + dz
    const useCache = this._blockCacheEnabled
    let cacheKey
    if (useCache) {
      cacheKey = (x + 1048576) * 1073741824 + (z + 1048576) * 512 + (y + 64)
      const cached = this._blockCache.get(cacheKey)
      if (cached !== undefined) return cached
    }

    tmpVec.x = x
    tmpVec.y = y
    tmpVec.z = z
    const b = this.bot.blockAt(tmpVec, false)
    if (!b) {
      if (useCache) this._blockCache.set(cacheKey, NULL_BLOCK)
      return NULL_BLOCK
    }
    b.climbable = this.climbables.has(b.type)
    b.safe = (b.boundingBox === 'empty' || b.climbable || this.carpets.has(b.type)) && !this.blocksToAvoid.has(b.type)
    b.physical = b.boundingBox === 'block' && !this.fences.has(b.type)
    b.replaceable = this.replaceables.has(b.type) && !b.physical
    b.liquid = this.liquids.has(b.type)
    b.height = y
    b.canFall = this.gravityBlocks.has(b.type)
    b.openable = this.openable.has(b.type)

    // Open doors, fence gates, and trapdoors should be passable
    if (this.doorLikeBlocks.has(b.type) && b.getProperties) {
      const props = b.getProperties()
      if (props && props.open) {
        b.safe = true
        b.physical = false
        b.shapes = []
      }
    }

    for (const shape of b.shapes) {
      b.height = Math.max(b.height, y + shape[4])
    }
    if (useCache) this._blockCache.set(cacheKey, b)
    return b
  }

  /**
   * Takes into account if the block is within a break exclusion area.
   * @param {import('prismarine-block').Block} block
   * @returns
   */
  safeToBreak (block) {
    if (!this.canDig) {
      // Allow breaking leaves even with canDig=false — they break instantly
      // and the bot needs to escape if spawned on a tree canopy
      if (this.allowBreakLeaves && block.name && block.name.includes('leaves')) {
        // fall through to remaining checks below
      } else {
        return false
      }
    }

    const aboveBlock = (this.dontCreateFlow || this.dontMineUnderFallingBlock)
      ? this.getBlock(block.position, 0, 1, 0)
      : null

    if (this.dontCreateFlow) {
      // false if next to liquid
      if (aboveBlock.liquid) return false
      if (this.getBlock(block.position, -1, 0, 0).liquid) return false
      if (this.getBlock(block.position, 1, 0, 0).liquid) return false
      if (this.getBlock(block.position, 0, 0, -1).liquid) return false
      if (this.getBlock(block.position, 0, 0, 1).liquid) return false
    }

    if (this.dontMineUnderFallingBlock) {
      // TODO: Determine if there are other blocks holding the entity up
      if (aboveBlock.canFall || (this.getNumEntitiesAt(block.position, 0, 1, 0) > 0)) {
        return false
      }
    }

    if (!block.type || this.blocksCantBreak.has(block.type) || this.exclusionBreak(block) >= 100) return false
    if (this.protectedBlockPositions.size > 0 && block.position) {
      const key = `${block.position.x},${block.position.y},${block.position.z}`
      if (this.protectedBlockPositions.has(key)) return false
    }
    return true
  }

  /**
   * Takes into account if the block is within the stepExclusionAreas. And returns 100 if a block to be broken is within break exclusion areas.
   * @param {import('prismarine-block').Block} block block
   * @param {[]} toBreak
   * @returns {number}
   */
  safeOrBreak (block, toBreak) {
    let cost = 0
    cost += this.exclusionStep(block) // Is excluded so can't move or break
    cost += this.getNumEntitiesAt(block.position, 0, 0, 0) * this.entityCost
    if (block.safe) return cost
    if (!this.safeToBreak(block)) return 100 // Can't break, so can't move
    toBreak.push(block.position)

    if (block.physical) cost += this.getNumEntitiesAt(block.position, 0, 1, 0) * this.entityCost // Add entity cost if there is an entity above (a breakable block) that will fall

    const tool = this.bot.pathfinder.bestHarvestTool(block)
    const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : []
    const effects = this.bot.entity.effects
    const digTime = block.digTime(tool ? tool.type : null, false, false, false, enchants, effects)
    const laborCost = (1 + 3 * digTime / 1000) * this.digCost
    cost += laborCost
    return cost
  }

  getMoveJumpUp (node, dir, neighbors) {
    const blockA = this.getBlock(node, 0, 2, 0)
    const blockH = this.getBlock(node, dir.x, 2, dir.z)
    const blockB = this.getBlock(node, dir.x, 1, dir.z)
    const blockC = this.getBlock(node, dir.x, 0, dir.z)

    let cost = 2 // move cost (move+jump)
    const toBreak = []
    const toPlace = []

    if (blockA.physical && (this.getNumEntitiesAt(blockA.position, 0, 1, 0) > 0)) return // Blocks A, B and H are above C, D and the player's space, we need to make sure there are no entities that will fall down onto our building space if we break them
    if (blockH.physical && (this.getNumEntitiesAt(blockH.position, 0, 1, 0) > 0)) return
    if (blockB.physical && !blockH.physical && !blockC.physical && (this.getNumEntitiesAt(blockB.position, 0, 1, 0) > 0)) return // It is fine if an ent falls on B so long as we don't need to replace block C

    if (!blockC.physical) {
      if (node.remainingBlocks === 0) return // not enough blocks to place

      if (this.getNumEntitiesAt(blockC.position, 0, 0, 0) > 0) return // Check for any entities in the way of a block placement

      const blockD = this.getBlock(node, dir.x, -1, dir.z)
      if (!blockD.physical) {
        if (node.remainingBlocks === 1) return // not enough blocks to place

        if (this.getNumEntitiesAt(blockD.position, 0, 0, 0) > 0) return // Check for any entities in the way of a block placement

        if (!blockD.replaceable) {
          if (!this.safeToBreak(blockD)) return
          cost += this.exclusionBreak(blockD)
          toBreak.push(blockD.position)
        }
        cost += this.exclusionPlace(blockD)
        toPlace.push({ x: node.x, y: node.y - 1, z: node.z, dx: dir.x, dy: 0, dz: dir.z, returnPos: new Vec3(node.x, node.y, node.z) })
        cost += this.placeCost // additional cost for placing a block
      }

      if (!blockC.replaceable) {
        if (!this.safeToBreak(blockC)) return
        cost += this.exclusionBreak(blockC)
        toBreak.push(blockC.position)
      }
      cost += this.exclusionPlace(blockC)
      toPlace.push({ x: node.x + dir.x, y: node.y - 1, z: node.z + dir.z, dx: 0, dy: 1, dz: 0 })
      cost += this.placeCost // additional cost for placing a block

      blockC.height += 1
    }

    const block0 = this.getBlock(node, 0, -1, 0)
    if (blockC.height - block0.height > 1.2) return // Too high to jump

    cost += this.safeOrBreak(blockA, toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(blockH, toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(blockB, toBreak)
    if (cost > 100) return

    neighbors.push(new Move(blockB.position.x, blockB.position.y, blockB.position.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace))
  }

  getMoveForward (node, dir, neighbors) {
    const blockB = this.getBlock(node, dir.x, 1, dir.z)
    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const blockD = this.getBlock(node, dir.x, -1, dir.z)

    let cost = 1 // move cost
    cost += this.exclusionStep(blockC)

    const toBreak = []
    const toPlace = []

    if (!blockD.physical && !blockC.liquid) {
      if (node.remainingBlocks === 0) return // not enough blocks to place

      if (this.getNumEntitiesAt(blockD.position, 0, 0, 0) > 0) return // D intersects an entity hitbox

      if (!blockD.replaceable) {
        if (!this.safeToBreak(blockD)) return
        cost += this.exclusionBreak(blockD)
        toBreak.push(blockD.position)
      }
      cost += this.exclusionPlace(blockD)
      toPlace.push({ x: node.x, y: node.y - 1, z: node.z, dx: dir.x, dy: 0, dz: dir.z })
      cost += this.placeCost // additional cost for placing a block
    }

    // Open doors/gates: skip safeOrBreak for both halves of door (blockB + blockC)
    if (this.canOpenDoors && blockC.openable && blockC.shapes && blockC.shapes.length !== 0) {
      if (!blockB.openable) {
        cost += this.safeOrBreak(blockB, toBreak)
        if (cost > 100) return
      }
      toPlace.push({ x: node.x + dir.x, y: node.y, z: node.z + dir.z, dx: 0, dy: 0, dz: 0, useOne: true })
    } else {
      cost += this.safeOrBreak(blockB, toBreak)
      if (cost > 100) return
      cost += this.safeOrBreak(blockC, toBreak)
      if (cost > 100) return
    }

    if (this.getBlock(node, 0, 0, 0).liquid) cost += this.liquidCost

    neighbors.push(new Move(blockC.position.x, blockC.position.y, blockC.position.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace))
  }

  getMoveDiagonal (node, dir, neighbors) {
    let cost = Math.SQRT2 // move cost
    const toBreak = []

    const blockC = this.getBlock(node, dir.x, 0, dir.z) // Landing block or standing on block when jumping up by 1
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

    // The bot's hitbox (0.6 blocks wide) clips both intermediates during
    // diagonal movement, so both must be passable to avoid getting stuck
    if (cost1 > 100 || cost2 > 100) return
    cost += cost1 + cost2
    toBreak.push(...toBreak1, ...toBreak2)
    if (cost > 100) return

    cost += this.safeOrBreak(this.getBlock(node, dir.x, y, dir.z), toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(this.getBlock(node, dir.x, y + 1, dir.z), toBreak)
    if (cost > 100) return

    if (this.getBlock(node, 0, 0, 0).liquid) cost += this.liquidCost

    const blockD = this.getBlock(node, dir.x, -1, dir.z)
    if (y === 1) { // Case jump up by 1
      if (blockC.height - block0.height > 1.2) return // Too high to jump
      cost += this.safeOrBreak(this.getBlock(node, 0, 2, 0), toBreak)
      if (cost > 100) return
      cost += 1
      neighbors.push(new Move(blockC.position.x, blockC.position.y + 1, blockC.position.z, node.remainingBlocks, cost, toBreak))
    } else if (blockD.physical || blockC.liquid) {
      neighbors.push(new Move(blockC.position.x, blockC.position.y, blockC.position.z, node.remainingBlocks, cost, toBreak))
    } else if (this.getBlock(node, dir.x, -2, dir.z).physical || blockD.liquid) {
      if (!blockD.safe) return // don't self-immolate
      cost += this.getNumEntitiesAt(blockC.position, 0, -1, 0) * this.entityCost
      neighbors.push(new Move(blockC.position.x, blockC.position.y - 1, blockC.position.z, node.remainingBlocks, cost, toBreak))
    }
  }

  getLandingBlock (node, dir) {
    let blockLand = this.getBlock(node, dir.x, -2, dir.z)
    while (blockLand.position && blockLand.position.y > this.bot.game.minY) {
      if (blockLand.liquid && blockLand.safe) return blockLand
      if (blockLand.physical) {
        if (node.y - blockLand.position.y <= this.maxDropDown) return this.getBlock(blockLand.position, 0, 1, 0)
        return null
      }
      if (!blockLand.safe) return null
      blockLand = this.getBlock(blockLand.position, 0, -1, 0)
    }
    return null
  }

  getMoveDropDown (node, dir, neighbors) {
    const blockB = this.getBlock(node, dir.x, 1, dir.z)
    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const blockD = this.getBlock(node, dir.x, -1, dir.z)

    let cost = 1 // move cost
    const toBreak = []
    const toPlace = []

    const blockLand = this.getLandingBlock(node, dir)
    if (!blockLand) return
    if (!this.infiniteLiquidDropdownDistance && ((node.y - blockLand.position.y) > this.maxDropDown)) return // Don't drop down into water

    cost += this.safeOrBreak(blockB, toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(blockC, toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(blockD, toBreak)
    if (cost > 100) return

    if (blockC.liquid) return // dont go underwater

    cost += this.getNumEntitiesAt(blockLand.position, 0, 0, 0) * this.entityCost // add cost for entities

    neighbors.push(new Move(blockLand.position.x, blockLand.position.y, blockLand.position.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace))
  }

  getMoveDown (node, neighbors) {
    const block0 = this.getBlock(node, 0, -1, 0)

    let cost = 1 // move cost
    const toBreak = []
    const toPlace = []

    const blockLand = this.getLandingBlock(node, { x: 0, z: 0 })
    if (!blockLand) return

    cost += this.safeOrBreak(block0, toBreak)
    if (cost > 100) return

    if (this.getBlock(node, 0, 0, 0).liquid) return // dont go underwater

    cost += this.getNumEntitiesAt(blockLand.position, 0, 0, 0) * this.entityCost // add cost for entities

    neighbors.push(new Move(blockLand.position.x, blockLand.position.y, blockLand.position.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace))
  }

  getMoveUp (node, neighbors) {
    const block1 = this.getBlock(node, 0, 0, 0)
    if (block1.liquid) return
    if (this.getNumEntitiesAt(node, 0, 0, 0) > 0) return // an entity (besides the player) is blocking the building area

    const block2 = this.getBlock(node, 0, 2, 0)

    let cost = 1 // move cost
    const toBreak = []
    const toPlace = []
    cost += this.safeOrBreak(block2, toBreak)
    if (cost > 100) return

    if (!block1.climbable) {
      if (!this.allow1by1towers || node.remainingBlocks === 0) return // not enough blocks to place

      if (!block1.replaceable) {
        if (!this.safeToBreak(block1)) return
        toBreak.push(block1.position)
      }

      const block0 = this.getBlock(node, 0, -1, 0)
      if (block0.physical && block0.height - node.y < -0.2) return // cannot jump-place from a half block

      cost += this.exclusionPlace(block1)
      toPlace.push({ x: node.x, y: node.y - 1, z: node.z, dx: 0, dy: 1, dz: 0, jump: true })
      cost += this.placeCost // additional cost for placing a block
    }

    if (cost > 100) return

    neighbors.push(new Move(node.x, node.y + 1, node.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace))
  }

  // Jump up, down or forward over a 1 block gap
  getMoveParkourForward (node, dir, neighbors) {
    const block0 = this.getBlock(node, 0, -1, 0)
    const block1 = this.getBlock(node, dir.x, -1, dir.z)
    if ((block1.physical && block1.height >= block0.height) ||
      !this.getBlock(node, dir.x, 0, dir.z).safe ||
      !this.getBlock(node, dir.x, 1, dir.z).safe) return
    if (this.getBlock(node, 0, 0, 0).liquid) return // cant jump from water

    let cost = 1

    // Leaving entities at the ceiling level (along path) out for now because there are few cases where that will be important
    cost += this.getNumEntitiesAt(node, dir.x, 0, dir.z) * this.entityCost

    // If we have a block on the ceiling, we cannot jump but we can still fall
    let ceilingClear = this.getBlock(node, 0, 2, 0).safe && this.getBlock(node, dir.x, 2, dir.z).safe

    // Similarly for the down path
    let floorCleared = !this.getBlock(node, dir.x, -2, dir.z).physical

    const maxD = this.allowSprinting ? 4 : 2

    for (let d = 2; d <= maxD; d++) {
      const dx = dir.x * d
      const dz = dir.z * d
      const blockA = this.getBlock(node, dx, 2, dz)
      const blockB = this.getBlock(node, dx, 1, dz)
      const blockC = this.getBlock(node, dx, 0, dz)
      const blockD = this.getBlock(node, dx, -1, dz)

      if (blockC.safe) cost += this.getNumEntitiesAt(blockC.position, 0, 0, 0) * this.entityCost

      if (ceilingClear && blockB.safe && blockC.safe && blockD.physical) {
        cost += this.exclusionStep(blockB)
        // Forward
        neighbors.push(new Move(blockC.position.x, blockC.position.y, blockC.position.z, node.remainingBlocks, cost, undefined, undefined, true))
        break
      } else if (ceilingClear && blockB.safe && blockC.physical) {
        // Up
        if (blockA.safe && d !== 4) { // 4 Blocks forward 1 block up is very difficult and fails often
          cost += this.exclusionStep(blockA)
          if (blockC.height - block0.height > 1.2) break // Too high to jump
          cost += this.getNumEntitiesAt(blockB.position, 0, 0, 0) * this.entityCost
          neighbors.push(new Move(blockB.position.x, blockB.position.y, blockB.position.z, node.remainingBlocks, cost, undefined, undefined, true))
          break
        }
      } else if ((ceilingClear || d === 2) && blockB.safe && blockC.safe && blockD.safe && floorCleared) {
        // Down
        const blockE = this.getBlock(node, dx, -2, dz)
        if (blockE.physical) {
          cost += this.exclusionStep(blockD)
          cost += this.getNumEntitiesAt(blockD.position, 0, 0, 0) * this.entityCost
          neighbors.push(new Move(blockD.position.x, blockD.position.y, blockD.position.z, node.remainingBlocks, cost, undefined, undefined, true))
        }
        floorCleared = floorCleared && !blockE.physical
      } else if (!blockB.safe || !blockC.safe) {
        break
      }

      ceilingClear = ceilingClear && blockA.safe
    }
  }

  // for each cardinal direction:
  // "." is head. "+" is feet and current location.
  // "#" is initial floor which is always solid. "a"-"u" are blocks to check
  //
  //   --0123-- horizontalOffset
  //  |
  // +2  aho
  // +1  .bip
  //  0  +cjq
  // -1  #dkr
  // -2   els
  // -3   fmt
  // -4   gn
  //  |
  //  dy

  /**
   * Add absolute block positions that should never be broken by the pathfinder.
   * @param {Array<{x: number, y: number, z: number}>} positions Array of block positions
   */
  protectBlocks (positions) {
    for (const pos of positions) {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
      this.protectedBlockPositions.add(key)
    }
  }

  /**
   * Add protected blocks from a structure definition.
   * @param {{x: number, y: number, z: number}} center Center coordinate of the structure
   * @param {Array<{x: number, y: number, z: number}>} relativePositions Relative block positions
   */
  protectStructureBlocks (center, relativePositions) {
    const cx = Math.floor(center.x)
    const cy = Math.floor(center.y)
    const cz = Math.floor(center.z)
    for (const rel of relativePositions) {
      const key = `${cx + Math.floor(rel.x)},${cy + Math.floor(rel.y)},${cz + Math.floor(rel.z)}`
      this.protectedBlockPositions.add(key)
    }
  }

  /**
   * Protect blocks from a structure's build commands (from struct_*.json).
   * Commands are processed in order: non-air blocks are added, air blocks are removed.
   * @param {{x: number, y: number, z: number}} origin Structure origin from blueprint.json coordinates
   * @param {Array<{cmd: string, block: string, x?: number, y?: number, z?: number, x1?: number, y1?: number, z1?: number, x2?: number, y2?: number, z2?: number}>} commands Build commands
   */
  protectStructureFromCommands (origin, commands) {
    const ox = Math.floor(origin.x)
    const oy = Math.floor(origin.y)
    const oz = Math.floor(origin.z)
    const localSet = new Set()

    for (const cmd of commands) {
      const isAir = cmd.block === 'air'
      if (cmd.cmd === 'sb') {
        const key = `${ox + cmd.x},${oy + cmd.y},${oz + cmd.z}`
        if (isAir) localSet.delete(key)
        else localSet.add(key)
      } else if (cmd.cmd === 'fill') {
        const minX = Math.min(cmd.x1, cmd.x2)
        const maxX = Math.max(cmd.x1, cmd.x2)
        const minY = Math.min(cmd.y1, cmd.y2)
        const maxY = Math.max(cmd.y1, cmd.y2)
        const minZ = Math.min(cmd.z1, cmd.z2)
        const maxZ = Math.max(cmd.z1, cmd.z2)
        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            for (let z = minZ; z <= maxZ; z++) {
              const key = `${ox + x},${oy + y},${oz + z}`
              if (isAir) localSet.delete(key)
              else localSet.add(key)
            }
          }
        }
      }
    }

    for (const key of localSet) {
      this.protectedBlockPositions.add(key)
    }
  }

  /**
   * Load protection for structures from blueprint data and their build commands.
   * @param {Array<{id: string, coordinates: {x: number, y: number, z: number}}>} structures Structures array from blueprint.json
   * @param {Object<string, Array>} structCommandsMap Map of structure id to build commands array from struct_*.json
   */
  loadProtectedStructures (structures, structCommandsMap) {
    for (const struct of structures) {
      const commands = structCommandsMap[struct.id]
      if (commands) {
        this.protectStructureFromCommands(struct.coordinates, commands)
      }
    }
  }

  /**
   * Load protected structures from a directory containing blueprint.json and struct_*.json files.
   * Reads blueprint.json for structure coordinates, then loads matching struct_*.json files.
   * @param {string} dirPath Path to the directory containing blueprint.json and struct_*.json
   * @param {function} [filter] Optional filter function (structure) => boolean, defaults to all structures
   * @returns {number} Number of protected block positions added
   */
  loadProtectedStructuresFromDir (dirPath, filter) {
    const blueprintPath = path.join(dirPath, 'blueprint.json')
    const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'))
    const structures = blueprint.structures || []
    const filtered = filter ? structures.filter(filter) : structures
    const before = this.protectedBlockPositions.size

    for (const struct of filtered) {
      const structFile = path.join(dirPath, `struct_${struct.id}.json`)
      if (fs.existsSync(structFile)) {
        const commands = JSON.parse(fs.readFileSync(structFile, 'utf8'))
        this.protectStructureFromCommands(struct.coordinates, commands)
      }
    }

    const added = this.protectedBlockPositions.size - before
    return added
  }

  /**
   * Clear all protected block positions.
   */
  clearProtectedBlocks () {
    this.protectedBlockPositions.clear()
  }

  getNeighbors (node) {
    this._blockCacheEnabled = true
    this._blockCache.clear()
    const neighbors = []

    // Simple moves in 4 cardinal points
    for (const i in cardinalDirections) {
      const dir = cardinalDirections[i]
      this.getMoveForward(node, dir, neighbors)
      this.getMoveJumpUp(node, dir, neighbors)
      this.getMoveDropDown(node, dir, neighbors)
      if (this.allowParkour) {
        this.getMoveParkourForward(node, dir, neighbors)
      }
    }

    // Diagonals
    for (const i in diagonalDirections) {
      const dir = diagonalDirections[i]
      this.getMoveDiagonal(node, dir, neighbors)
    }

    this.getMoveDown(node, neighbors)
    this.getMoveUp(node, neighbors)

    this._blockCacheEnabled = false
    this._blockCache.clear()
    return neighbors
  }
}

module.exports = Movements
