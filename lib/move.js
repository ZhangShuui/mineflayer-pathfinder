const { Vec3 } = require('vec3')

const EMPTY = []

class Move extends Vec3 {
  constructor (x, y, z, remainingBlocks, cost, toBreak = EMPTY, toPlace = EMPTY, parkour = false) {
    super(Math.floor(x), Math.floor(y), Math.floor(z))
    this.remainingBlocks = remainingBlocks
    this.cost = cost
    this.toBreak = toBreak
    this.toPlace = toPlace
    this.parkour = parkour

    // Numeric hash: 21-bit x + 21-bit z + 9-bit y = 51 bits (within MAX_SAFE_INTEGER)
    // Supports coordinates ±1,048,575 on x/z, y in [-64, 447]
    this.hash = (this.x + 1048576) * 1073741824 + (this.z + 1048576) * 512 + (this.y + 64)
  }
}

module.exports = Move
