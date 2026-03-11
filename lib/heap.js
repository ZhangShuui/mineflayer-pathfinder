class BinaryHeapOpenSet {
  constructor () {
    // Initialing the array heap and adding a dummy element at index 0
    this.heap = [null]
  }

  size () {
    return this.heap.length - 1
  }

  isEmpty () {
    return this.heap.length === 1
  }

  push (val) {
    // Inserting the new node at the end of the heap array
    this.heap.push(val)
    val._heapIndex = this.heap.length - 1

    // Finding the correct position for the new node
    this._bubbleUp(val._heapIndex)
  }

  update (val) {
    // Use stored index instead of O(n) indexOf
    this._bubbleUp(val._heapIndex)
  }

  _bubbleUp (current) {
    let parent = current >>> 1

    // Traversing up the parent node until the current node is greater than the parent
    while (current > 1 && this.heap[parent].f > this.heap[current].f) {
      // Swap and update stored indices
      const tmp = this.heap[parent]
      this.heap[parent] = this.heap[current]
      this.heap[current] = tmp
      this.heap[parent]._heapIndex = parent
      this.heap[current]._heapIndex = current

      current = parent
      parent = current >>> 1
    }
  }

  pop () {
    // Smallest element is at the index 1 in the heap array
    const smallest = this.heap[1]

    this.heap[1] = this.heap[this.heap.length - 1]
    this.heap.splice(this.heap.length - 1)

    const size = this.heap.length - 1

    if (size < 2) return smallest

    const val = this.heap[1]
    val._heapIndex = 1
    let index = 1
    let smallerChild = 2
    const cost = val.f
    do {
      let smallerChildNode = this.heap[smallerChild]
      if (smallerChild < size - 1) {
        const rightChildNode = this.heap[smallerChild + 1]
        if (smallerChildNode.f > rightChildNode.f) {
          smallerChild++
          smallerChildNode = rightChildNode
        }
      }
      if (cost <= smallerChildNode.f) {
        break
      }
      this.heap[index] = smallerChildNode
      smallerChildNode._heapIndex = index
      this.heap[smallerChild] = val
      val._heapIndex = smallerChild
      index = smallerChild

      smallerChild *= 2
    } while (smallerChild <= size)

    return smallest
  }
}

module.exports = BinaryHeapOpenSet
