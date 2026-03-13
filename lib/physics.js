const { PlayerState } = require('prismarine-physics')

class Physics {
  constructor (bot) {
    this.bot = bot
    this.world = { getBlock: (pos) => { return bot.blockAt(pos, false) } }
    this._simControl = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  }

  /**
   *
   * @param {function} goal A function is the goal has been reached or not
   * @param {function} controller Controller that can change the current control State for the next tick
   * @param {number} ticks Number of ticks to simulate
   * @param {object} state Starting control state to begin the simulation with
   * @returns { import('prismarine-physics').PlayerState } A player state of the final simulation tick
   */
  simulateUntil (goal, controller = () => {}, ticks = 1, state = null) {
    if (!state) {
      const sc = this._simControl
      sc.forward = this.bot.controlState.forward
      sc.back = this.bot.controlState.back
      sc.left = this.bot.controlState.left
      sc.right = this.bot.controlState.right
      sc.jump = this.bot.controlState.jump
      sc.sprint = this.bot.controlState.sprint
      sc.sneak = this.bot.controlState.sneak
      state = new PlayerState(this.bot, sc)
    }

    for (let i = 0; i < ticks; i++) {
      controller(state, i)
      this.bot.physics.simulatePlayer(state, this.world)
      if (state.isInLava) return state
      if (goal(state)) return state
    }

    return state
  }

  simulateUntilNextTick () {
    return this.simulateUntil(() => false, () => {}, 1)
  }

  simulateUntilOnGround (ticks = 5) {
    return this.simulateUntil(state => state.onGround, () => {}, ticks)
  }

  canStraightLine (path, sprint = false) {
    const reached = this.getReached(path)
    const state = this.simulateUntil(reached, this.getController(path[0], false, sprint), 200)
    if (reached(state)) return true

    if (sprint) {
      if (this.canSprintJump(path, 0)) return false
    } else {
      if (this.canWalkJump(path, 0)) return false
    }

    for (let i = 1; i < 7; i++) {
      if (sprint) {
        if (this.canSprintJump(path, i)) return true
      } else {
        if (this.canWalkJump(path, i)) return true
      }
    }
    return false
  }

  canStraightLineBetween (n1, n2) {
    const reached = (state) => {
      const dx = n2.x - state.pos.x
      const dy = n2.y - state.pos.y
      const dz = n2.z - state.pos.z
      return (dx * dx + dz * dz) <= 0.0225 && Math.abs(dy) < 0.001 && (state.onGround || state.isInWater)
    }
    const sc = this._simControl
    sc.forward = this.bot.controlState.forward
    sc.back = this.bot.controlState.back
    sc.left = this.bot.controlState.left
    sc.right = this.bot.controlState.right
    sc.jump = this.bot.controlState.jump
    sc.sprint = this.bot.controlState.sprint
    sc.sneak = this.bot.controlState.sneak
    const state = new PlayerState(this.bot, sc)
    state.pos.update(n1)
    this.simulateUntil(reached, this.getController(n2, false, true), Math.floor(5 * n1.distanceTo(n2)), state)
    return reached(state)
  }

  canSprintJump (path, jumpAfter = 0) {
    const reached = this.getReached(path)
    const state = this.simulateUntil(reached, this.getController(path[0], true, true, jumpAfter), 20)
    return reached(state)
  }

  canWalkJump (path, jumpAfter = 0) {
    const reached = this.getReached(path)
    const state = this.simulateUntil(reached, this.getController(path[0], true, false, jumpAfter), 20)
    return reached(state)
  }

  getReached (path) {
    const target = path[0]
    return (state) => {
      const dx = target.x - state.pos.x
      const dy = target.y - state.pos.y
      const dz = target.z - state.pos.z
      return Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < 1
    }
  }

  getController (nextPoint, jump, sprint, jumpAfter = 0) {
    return (state, tick) => {
      const dx = nextPoint.x - state.pos.x
      const dz = nextPoint.z - state.pos.z
      state.yaw = Math.atan2(-dx, -dz)

      state.control.forward = true
      state.control.jump = jump && tick >= jumpAfter
      state.control.sprint = sprint
    }
  }
}

module.exports = Physics
