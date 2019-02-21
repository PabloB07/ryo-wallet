import { Miner } from "./pool/miner"
import { BlockTemplate } from "./pool/blockTemplate"

const cnUtil = require("cryptoforknote-util")
const request = require("request-promise")
const queue = require("promise-queue")
const http = require("http")
const net = require("net")
const fs = require("fs")
const util = require("util")
const dateFormat = require("dateformat")
const clc = require("cli-color")
const BigInt = require("big-integer")
const utils = require("./pool/utils.js")
const diff1 = utils.diff1
const noncePattern = utils.noncePattern
const instanceId = utils.instanceId()

export class Pool {
    constructor(backend) {
        this.backend = backend

        this.server = null
        this.agent = null
        this.queue = new queue(1, Infinity)

        this.jobRefreshTimeout = null
        this.clearMinerInterval = null
        this.varDiffInterval = null
    }

    start(options) {

        if(options.daemon.type === "remote") {
            return false
        }

        this.stop().then(() => {

            this.server = null
            this.agent = new http.Agent({keepAlive: true, maxSockets: 1})

            this.connectedMiners = {}
            this.validBlockTemplates = []
            this.currentBlockTemplate = null

            this.protocol = "http://"
            this.daemon_hostname = options.daemon.rpc_bind_ip
            this.daemon_port = options.daemon.rpc_bind_port


            // TODO merge from config file
            this.pool_config = {
                server: {
                    //bindIP: "127.0.0.1",
                    bindIP: "0.0.0.0",
                    bindPort: 3333,
                },
                mining: {
                    address: "RYoTqzy6zKKeP9UhkPWZpwMiAzV1cPE3vews8Q7vT4mKFMTqGPXBPNsWaKSu27ybqTNwqtqeKahkrBPmN1aEb4qEGKtgUPJvwhE",
                    blockRefreshInterval: 1,
                    cnBlobType: 4,
                    minerTimeout: 900,
                },
                varDiff: {
                    startDiff: 5000,
                    minDiff: 100,
                    maxDiff: 100000000,
                    targetTime: 60,
                    retargetTime: 30,
                    variancePercent: 30,
                    maxJump: 100,
                    fixedDiffSeparator: ".",
                },
            }

            const waitForDaemon = (attempt) => {
                this.log("info", "Attempting to connect to daemon attempt: %s", [attempt])
                this.jobRefresh(true).then(() => {
                    this.startHeartbeat()
                    this.startServer()
                }).catch(error => {
                    if(attempt++ == 5) {
                        this.log("error", "Could not start pool: %s", [error])
                        // todo alert user!
                        // also todo, make it so it keeps trying while daemon is "core is busy"
                    } else {
                        setTimeout(() => {
                            waitForDaemon(attempt)
                        }, 2000)
                    }
                })
            }
            waitForDaemon(1)
        })
    }


    jobRefresh(loop) {
        return new Promise((resolve, reject) => {
            this.getBlockTemplate().then(data => {
                if(data.hasOwnProperty("error")) {
                    this.log("error", "Error polling getblocktemplate %j", [data.error.message])
                    reject(data.error.message)
                    return false
                }

                // todo this seems bad -- if it fails it never starts again
                if(loop) {
                    setTimeout(() => {
                        this.jobRefresh(true).catch(() => {})
                    }, this.pool_config.mining.blockRefreshInterval * 1000)
                }

                if(!this.currentBlockTemplate || data.result.height > this.currentBlockTemplate.height) {
                    this.log("info", "New block to mine at height %d w/ difficulty of %d", [data.result.height, data.result.difficulty])
                    this.processBlockTemplate(data.result)
                }
                resolve()
            }).catch(error => {
                this.log("error", "Error polling getblocktemplate %j", [data.error.message])
                reject(data.error.message)
            })
        })
    }

    processBlockTemplate(template) {
        if(this.currentBlockTemplate)
            this.validBlockTemplates.push(this.currentBlockTemplate)

        if(this.validBlockTemplates.length > 3)
            this.validBlockTemplates.shift()

        this.currentBlockTemplate = new BlockTemplate(template, instanceId, this.pool_config.mining.cnBlobType)

        for(let minerId in this.connectedMiners) {
            let miner = this.connectedMiners[minerId]
            miner.pushMessage("job", miner.getJob())
        }
    }


    startHeartbeat() {
        if(this.clearMinerInterval)
            clearInterval(this.clearMinerInterval)
        if(this.varDiffInterval)
            clearInterval(this.varDiffInterval)

        this.varDiffInterval = setInterval(() => {
            let now = Date.now() / 1000 | 0
            for(let minerId in this.connectedMiners) {
                let miner = this.connectedMiners[minerId]
                if(!miner.noRetarget) {
                    miner.retarget(now)
                }
            }
        }, this.pool_config.varDiff.retargetTime * 1000)

        this.clearMinerInterval = setInterval(() => {
            let now = Date.now()
            let timeout = this.pool_config.mining.minerTimeout * 1000
            for(let minerId in this.connectedMiners) {
                let miner = this.connectedMiners[minerId]
                if(now - miner.lastBeat > timeout) {
                    this.log("warn", "Miner timed out and disconnected %s@%s", [miner.login, miner.ip])
                    miner.socket.destroy()
                    delete this.connectedMiners[minerId]
                }
            }
        }, 30000)
    }

    startServer() {

        this.server = net.createServer(socket => {
            socket.setKeepAlive(true)
            socket.setEncoding("utf8")
            let dataBuffer = ""

            socket.on("data", d => {
                dataBuffer += d
                if(Buffer.byteLength(dataBuffer, "utf8") > 10240) { //10KB
                    dataBuffer = null
                    this.log("warn", "Socket flooding detected and prevented from %s", [socket.remoteAddress])
                    socket.destroy()
                    return
                }
                if(dataBuffer.indexOf("\n") !== -1) {
                    var messages = dataBuffer.split("\n")
                    var incomplete = dataBuffer.slice(-1) === "\n" ? "" : messages.pop()
                    for(var i = 0; i < messages.length; i++) {
                        var message = messages[i]
                        if(message.trim() === "") continue
                        var jsonData
                        try{
                            jsonData = JSON.parse(message)
                        }
                        catch(e) {
                            if(message.indexOf("GET /") === 0) {
                                if(message.indexOf("HTTP/1.1") !== -1) {
                                    socket.end("HTTP/1.1 200 OK\nContent-Type: text/plain\nContent-Length: 20\n\nMining server online")
                                    break
                                } else if(message.indexOf("HTTP/1.0") !== -1) {
                                    socket.end("HTTP/1.0 200 OK\nContent-Type: text/plain\nContent-Length: 20\n\nMining server online")
                                    break
                                }
                            }
                            this.log("warn", "Malformed message from %s: %s", [socket.remoteAddress, message])
                            socket.destroy()
                            break
                        }
                        try {
                            if(!jsonData.id) {
                                this.log("warn", "Miner RPC request missing RPC id")
                                return
                            } else if(!jsonData.method) {
                                this.log("warn", "Miner RPC request missing RPC method")
                                return
                            } else if(!jsonData.params) {
                                this.log("warn", "Miner RPC request missing RPC params")
                                return
                            }

                            this.handleMinerMethod(jsonData, socket)

                        } catch(e) {
                            this.log("warn", "Malformed message from " + socket.remoteAddress + " generated an exception. Message: " + message)
                            if(e.message) this.log("warn", "Exception: " + e.message)
                            console.trace() // todo tmp
                        }
                    }
                    dataBuffer = incomplete
                }
            }).on("error", function(err) {
                if(err.code !== "ECONNRESET")
                    this.log("warn", "Socket error from %s %j", [socket.remoteAddress, err])
            }).on("close", function() {
            })

        }).listen(this.pool_config.server.bindPort, this.pool_config.server.bindIP, (error, result) => {
            if(error) {
                this.log("error", "Could not start pool server on port %d", [this.pool_config.server.bindPort, error])
                // TODO show error to UI
                return
            }
            this.log("info", "Started server listening on port %d", [this.pool_config.server.bindPort])
        })

    }

    handleMinerMethod(jsonData, socket) {

        let method = jsonData.method
        let params = jsonData.params
        let miner = this.connectedMiners[params.id]

        const sendReply = function(error, result) {
            if(!socket.writable) return
            var sendData = JSON.stringify({
                id: jsonData.id,
                jsonrpc: "2.0",
                error: error ? {code: -1, message: error} : null,
                result: result
            })
            socket.write(sendData + "\n")
        }

        switch(method) {
            case "login":
                const minerId = utils.uid() //TODO port

                let ip = socket.remoteAddress
                let port = socket.remotePort
                let login = params.login
                let pass = params.pass
                let workerName = ""

                if(params.rigid) {
                    workerName = params.rigid.trim()
                } else if(pass) {
                    workerName = pass.trim()
                    if(workerName.toLowerCase() === "x") {
                        workerName = ""
                    }
                }
                if(!workerName || workerName === "") {
                    workerName = "Worker_1" // TODO make random number or something
                }
                workerName = utils.cleanupSpecialChars(workerName)

                let difficulty = this.pool_config.varDiff.startDiff
                let noRetarget = false

                const fixedDiffCharPos = login.lastIndexOf(this.pool_config.varDiff.fixedDiffSeparator)
                if(fixedDiffCharPos !== -1 && (login.length - fixedDiffCharPos < 32)) {
                    diffValue = login.substr(fixedDiffCharPos + 1)
                    difficulty = parseInt(diffValue)
                    if(!difficulty || difficulty != diffValue) {
                        difficulty = this.pool_config.varDiff.startDiff
                    } else {
                        noRetarget = true
                        if(difficulty < this.pool_config.varDiff.minDiff) {
                            difficulty = this.pool_config.varDiff.minDiff
                        }
                    }
                }

                const variance = this.pool_config.varDiff.variancePercent / 100 * this.pool_config.varDiff.targetTime
                const varDiff = {
                    difficulty: difficulty,
                    noRetarget: noRetarget,
                    variance: variance,
                    bufferSize: this.pool_config.varDiff.retargetTime / this.pool_config.varDiff.targetTime * 4,
                    tMin: this.pool_config.varDiff.targetTime - variance,
                    tMax: this.pool_config.varDiff.targetTime + variance,
                    maxJump: this.pool_config.varDiff.maxJump
                }

                let newMiner = new Miner(this, minerId, login, pass, ip, port, workerName, varDiff, socket)

                this.connectedMiners[minerId] = newMiner

                sendReply(null, {
                    id: minerId,
                    job: newMiner.getJob(),
                    status: "OK"
                })

                break
            case "getjob":
                if(!miner) {
                    sendReply("Unauthenticated")
                    return
                }
                miner.heartbeat()
                sendReply(null, miner.getJob())
                break
            case "submit":
                if(!miner) {
                    sendReply("Unauthenticated")
                    return
                }
                miner.heartbeat()

                var job = miner.validJobs.filter(function(job) {
                    return job.id === params.job_id
                })[0]

                if(!job) {
                    sendReply("Invalid job id")
                    return
                }

                if(!params.nonce || !params.result) {
                    sendReply("Attack detected")
                    return
                }

                if(!noncePattern.test(params.nonce)) {
                    var minerText = miner ? (" " + miner.login + "@" + miner.ip) : ""
                    sendReply("Duplicate share")
                    return
                }

                // Force lowercase for further comparison
                params.nonce = params.nonce.toLowerCase()

                if(job.submissions.indexOf(params.nonce) !== -1) {
                    var minerText = miner ? (" " + miner.login + "@" + miner.ip) : ""
                    sendReply("Duplicate share")
                    return
                }

                job.submissions.push(params.nonce)

                var blockTemplate = this.currentBlockTemplate.height === job.height ? this.currentBlockTemplate : this.validBlockTemplates.filter(function(t) {
                    return t.height === job.height
                })[0]

                if(!blockTemplate) {
                    sendReply("Block expired")
                    return
                }

                var shareAccepted = this.processShare(miner, job, blockTemplate, params.nonce, params.result)

                if(!shareAccepted) {
                    sendReply("Rejected share: invalid result")
                    return
                }

                var now = Date.now() / 1000 | 0
                miner.shareTimeRing.append(now - miner.lastShareTime)
                miner.lastShareTime = now

                sendReply(null, {status: "OK"})
                break
            case "keepalived":
                if(!miner) {
                    sendReply("Unauthenticated")
                    return
                }
                miner.heartbeat()
                sendReply(null, { status:"KEEPALIVED" })
                break
            default:
                sendReply("Invalid method")
                break
        }
    }

    // sendReply(socket, error, result) {
    //     if(!socket.writable) return
    //     let sendData = JSON.stringify({
    //         id: jsonData.id,
    //         jsonrpc: "2.0",
    //         error: error ? {code: -1, message: error} : null,
    //         result: result
    //     })
    //     socket.write(sendData + "\n")
    // }

    processShare(miner, job, blockTemplate, nonce, hash) {

        var template = Buffer.alloc(blockTemplate.buffer.length)
        blockTemplate.buffer.copy(template)
        template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset)

        var shareBuffer = cnUtil.construct_block_blob(template, Buffer.from(nonce, "hex"), this.pool_config.mining.cnBlobType)

        // var hashArray = hash.toByteArray().reverse()
        // var hashNum = BigInt("0x"+Buffer.from(hashArray).toString("hex"))
        // var hashDiff = diff1.div(hashNum)

        // var hashArray = hash.toByteArray().reverse()
        // var hashNum = bignum.fromBuffer(Buffer.from(hashArray))
        // var hashDiff = diff1.div(hashNum)

        var hashArray = [...Buffer.from(hash, "hex")].reverse()
        var hashNum = BigInt.fromArray(hashArray, 256, false)
        var hashDiff = diff1.divide(hashNum)

        if(hashDiff.geq(blockTemplate.difficulty)) {
            this.submitBlock(shareBuffer.toString("hex")).then((data) => {
                if(data.hasOwnProperty("error")) {
                    this.log("error", "Error submitting block at height %d from %s@%s, - %j", [job.height, miner.login, miner.ip, error])
                    recordShareData(miner, job, hashDiff.toString(), false, null)
                    return false
                }
                const blockFastHash = cnUtil.get_block_id(shareBuffer, this.pool_config.mining.cnBlobType).toString("hex")
                this.log("info",
                         "Block %s found at height %d by miner %s@%s - submit result: %j",
                         [blockFastHash.substr(0, 6), job.height, miner.login, miner.ip, data.result]
                        )
                this.recordShareData(miner, job, hashDiff.toString(), true, blockFastHash, blockTemplate)
                this.jobRefresh().catch(() => {})
            }).catch(error => {
                this.log("error", "Error submitting block at height %d from %s@%s, - %j", [job.height, miner.login, miner.ip, error])
                recordShareData(miner, job, hashDiff.toString(), false, null)
            })
        } else if(hashDiff.lt(job.difficulty)) {
            this.log("warn", "Rejected low difficulty share of %s from %s@%s", [hashDiff.toString(), miner.login, miner.ip])
            return false
        } else {
            this.recordShareData(miner, job, hashDiff.toString(), false, null)
        }

        return true
    }



    recordShareData(miner, job, shareDiff, blockCandidate, hashHex, blockTemplate) {
        var dateNow = Date.now()
        var dateNowSeconds = dateNow / 1000 | 0

        // should use sqlite3 here!? Persistence would be nice

        // record diff for current share (used for total block effort)
        //updateScore = ["hincrbyfloat", config.coin + ":scores:roundCurrent", miner.login, job.score]


        // record time and diff of share for this worker (used for hashrate)
        //["zadd", config.coin + ":hashrate", dateNowSeconds, [job.difficulty, miner.login, dateNow].join(":")],


        // add job diff to total hashes for this worker
        //["hincrby", config.coin + ":workers:" + miner.login, "hashes", job.difficulty],

        // set last share for this worker
        // ["hset", config.coin + ":workers:" + miner.login, "lastShare", dateNowSeconds],

        // we must also clean some stuff up


        // if(blockCandidate) {
        //     redisCommands.push(["hset", config.coin + ":stats", "lastBlockFound", Date.now()]);
        //     redisCommands.push(["rename", config.coin + ":scores:roundCurrent", config.coin + ":scores:round" + job.height]);
        //     redisCommands.push(["rename", config.coin + ":shares_actual:roundCurrent", config.coin + ":shares_actual:round" + job.height]);
        //     redisCommands.push(["hgetall", config.coin + ":scores:round" + job.height]);
        //     redisCommands.push(["hgetall", config.coin + ":shares_actual:round" + job.height]);
        // }


        // if(blockCandidate) {
        //     var workerScores = replies[replies.length - 2];
        //     var workerShares = replies[replies.length - 1];
        //     var totalScore = Object.keys(workerScores).reduce(function(p, c) {
        //         return p + parseFloat(workerScores[c])
        //     }, 0);
        //     var totalShares = Object.keys(workerShares).reduce(function(p, c) {
        //         return p + parseInt(workerShares[c])
        //     }, 0);
        //     redisClient.zadd(config.coin + ":blocks:candidates", job.height, [
        //         hashHex,
        //         Date.now() / 1000 | 0,
        //         blockTemplate.difficulty,
        //         totalShares,
        //         totalScore
        //     ].join(":"), function(err, result) {
        //         if(err) {
        //             this.log("error", "Failed inserting block candidate %s \n %j", [hashHex, err]);
        //         }
        //     });

        //     notifications.sendToAll("blockFound", {
        //         "HEIGHT": job.height,
        //         "HASH": hashHex,
        //         "DIFFICULTY": blockTemplate.difficulty,
        //         "SHARES": totalShares,
        //         "MINER": miner.login.substring(0,7)+"..."+miner.login.substring(miner.login.length-7)
        //     });

        // }
        this.log("info", "Accepted share at difficulty %d/%d from %s@%s", [job.difficulty, shareDiff, miner.login, miner.ip])

    }


    getCurrentBlockTemplate() {
        return this.currentBlockTemplate
    }

    getBlockTemplate() {
        return this.sendRPC("getblocktemplate", {
            reserve_size: 8,
            wallet_address: this.pool_config.mining.address
        })
    }

    submitBlock(block) {
        return this.sendRPC("submit_block", [block])
    }

    sendRPC(method, params={}, uri=false) {
        let id = this.id++
        let options = {
            uri: uri ? uri : `${this.protocol}${this.daemon_hostname}:${this.daemon_port}/json_rpc`,
            method: "POST",
            json: {
                jsonrpc: "2.0",
                id: id,
                method: method
            },
            agent: this.agent
        }
        if(Array.isArray(params) || Object.keys(params).length !== 0) {
            options.json.params = params
        }
        return this.queue.add(() => {
            return request(options)
                .then((response) => {
                    if(response.hasOwnProperty("error")) {
                        return {
                            method: method,
                            params: params,
                            error: response.error
                        }
                    }
                    return {
                        method: method,
                        params: params,
                        result: response.result
                    }
                }).catch(error => {
                    return {
                        method: method,
                        params: params,
                        error: {
                            code: -1,
                            message: "Cannot connect to daemon-rpc",
                            cause: error.cause
                        }
                    }
                })
        })
    }

    handle(data) {
        let params = data.data
        switch (data.method) {
            case "start_pool":
                break
            case "stop_pool":
                break
            default:
        }
    }

    sendGateway(method, data) {
        this.backend.send(method, data)
    }

    log(severity, message, data) {

        const severityMap = {
            "info": clc.blue,
            "warn": clc.yellow,
            "error": clc.red
        }

        var time = dateFormat(new Date(), "yyyy-mm-dd HH:MM:ss")
        var formattedMessage = message

        if(data) {
            data.unshift(message)
            formattedMessage = util.format.apply(null, data)
        }

        console.log(severityMap[severity](time) + clc.white.bold(" [pool] ") + formattedMessage)
        // console.log(time + " [pool] " + formattedMessage)

    }

    stop() {
        return new Promise((resolve, reject) => {
            if(this.jobRefreshTimeout)
                clearTimeout(this.jobRefreshTimeout)
            if(this.clearMinerInterval)
                clearInterval(this.clearMinerInterval)
            if(this.varDiffInterval)
                clearInterval(this.varDiffInterval)
            if(this.agent)
                this.agent.destroy()
            for(let minerId in this.connectedMiners) {
                let miner = this.connectedMiners[minerId]
                this.log("warn", "Closing connection %s@%s", [miner.login, miner.ip])
                miner.socket.destroy()
                delete this.connectedMiners[minerId]
            }
            if(this.server) {
                this.server.close(() => {
                    resolve()
                })
            } else {
                resolve()
            }
        })
    }
    quit() {
        return this.stop()
    }
}
