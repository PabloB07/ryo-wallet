export class RingBuffer {

    constructor(maxSize) {
        this.maxSize = maxSize
        this.data = []
        this.cursor = 0
        this.isFull = false
    }

    append(x) {
        if(this.isFull) {
            this.data[this.cursor] = x
            this.cursor = (this.cursor + 1) % this.maxSize
        } else {
            this.data.push(x)
            this.cursor++
            if(this.data.length === this.maxSize) {
                this.cursor = 0
                this.isFull = true
            }
        }
    }

    avg(plusOne) {
        var sum = this.data.reduce(function(a, b){ return a + b }, plusOne || 0)
        return sum / ((this.isFull ? this.maxSize : this.cursor) + (plusOne ? 1 : 0))
    }

    size() {
        return this.isFull ? this.maxSize : this.cursor
    }

    clear() {
        this.data = []
        this.cursor = 0
        this.isFull = false
    }

}
