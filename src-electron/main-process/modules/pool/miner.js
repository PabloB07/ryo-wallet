import { RingBuffer } from "./ringBuffer"

//const bignum = require("bignum")
const BigInt = require("big-integer")

const utils = require("./utils.js")
const diff1 = utils.diff1

export class Miner {

    constructor(pool, id, login, pass, ip, port, workerName, varDiff, socket) {
        this.pool = pool
        this.id = id
        this.login = login
        this.pass = pass
        this.ip = ip
        this.port = port
        this.workerName = workerName
        this.heartbeat()
        this.varDiff = varDiff
        this.noRetarget = varDiff.noRetarget
        this.difficulty = varDiff.difficulty
        this.validJobs = []

        this.shareTimeRing = new RingBuffer(16)
        this.lastShareTime = Date.now() / 1000 | 0

        this.socket = socket
    }

    pushMessage (method, params) {
        if(!this.socket.writable) return
        var sendData = JSON.stringify({
            jsonrpc: "2.0",
            method: method,
            params: params
        })
        this.socket.write(sendData + "\n")
    }

    retarget(now) {
        const sinceLast = now - this.lastShareTime
        const decreaser = sinceLast > this.varDiff.tMax

        const avg = this.shareTimeRing.avg(decreaser ? sinceLast : null)

        let newDiff
        let direction

        if(avg > this.varDiff.tMax && this.difficulty > this.varDiff.minDiff) {
            newDiff = this.varDiff.targetTime / avg * this.difficulty
            newDiff = newDiff > this.varDiff.minDiff ? newDiff : this.varDiff.minDiff
            direction = -1
        } else if(avg < this.varDiff.tMin && this.difficulty < this.varDiff.maxDiff) {
            newDiff = this.varDiff.targetTime / avg * this.difficulty
            newDiff = newDiff < this.varDiff.maxDiff ? newDiff : this.varDiff.maxDiff
            direction = 1
        } else {
            return
        }

        if(Math.abs(newDiff - this.difficulty) / this.difficulty * 100 > this.varDiff.maxJump) {
            var change = this.varDiff.maxJump / 100 * this.difficulty * direction
            newDiff = this.difficulty + change
        }

        this.setNewDiff(newDiff)
        this.shareTimeRing.clear()
        if(decreaser) this.lastShareTime = now
    }
    setNewDiff(newDiff) {
        newDiff = Math.round(newDiff)
        if(this.difficulty === newDiff) return
        this.pool.log("info", "Retargetting difficulty %d to %d for %s", [this.difficulty, newDiff, this.login])
        this.pendingDifficulty = newDiff
        this.pushMessage("job", this.getJob())
    }
    heartbeat() {
        this.lastBeat = Date.now()
    }

    getTargetHex() {
        if(this.pendingDifficulty) {
            this.lastDifficulty = this.difficulty
            this.difficulty = this.pendingDifficulty
            this.pendingDifficulty = null
        }

        var padded = Buffer.alloc(32)
        padded.fill(0)

        var diffArray = diff1.divide(this.difficulty).toArray(256).value
        var diffBuff = Buffer.from(diffArray)
        diffBuff.copy(padded, 32 - diffBuff.length)

        var buff = padded.slice(0, 4)
        var buffReversed = Buffer.allocUnsafe(buff.length)

        for(var i = 0, j = buff.length - 1; i <= j; ++i, --j) {
            buffReversed[i] = buff[j]
            buffReversed[j] = buff[i]
        }

        this.target = buffReversed.readUInt32BE(0)
        var hex = buffReversed.toString("hex")
        return hex
    }


    // getTargetHex() {
    //     if(this.pendingDifficulty) {
    //         this.lastDifficulty = this.difficulty
    //         this.difficulty = this.pendingDifficulty
    //         this.pendingDifficulty = null
    //     }

    //     var padded = Buffer.alloc(32)
    //     padded.fill(0)

    //     var diffBuff = diff1.div(this.difficulty).toBuffer()
    //     diffBuff.copy(padded, 32 - diffBuff.length)

    //     var buff = padded.slice(0, 4)
    //     var buffArray = buff.toByteArray().reverse()
    //     var buffReversed = Buffer.from(buffArray)
    //     this.target = buffReversed.readUInt32BE(0)
    //     var hex = buffReversed.toString("hex")
    //     return hex
    // }

    getJob() {
        const currentBlockTemplate = this.pool.getCurrentBlockTemplate()

        if(this.lastBlockHeight === currentBlockTemplate.height && !this.pendingDifficulty) {
            return {
                blob: "",
                job_id: "",
                target: ""
            }
        }

        const blob = currentBlockTemplate.nextBlob()
        this.lastBlockHeight = currentBlockTemplate.height
        const target = this.getTargetHex()

        const newJob = {
            id: utils.uid(),
            extraNonce: currentBlockTemplate.extraNonce,
            height: currentBlockTemplate.height,
            difficulty: this.difficulty,
            diffHex: this.diffHex,
            submissions: []
        }

        this.validJobs.push(newJob)

        if(this.validJobs.length > 4)
            this.validJobs.shift()

        return {
            blob: blob,
            job_id: newJob.id,
            target: target,
            id: this.id
        }
    }
}
