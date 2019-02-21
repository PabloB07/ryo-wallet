const cnUtil = require("cryptoforknote-util")

export class BlockTemplate {
    constructor(template, instanceId, cnBlobType) {
        this.cnBlobType = cnBlobType
        this.blob = template.blocktemplate_blob
        this.difficulty = template.difficulty
        this.height = template.height
        this.reserveOffset = template.reserved_offset
        this.buffer = Buffer.from(this.blob, "hex")
        instanceId.copy(this.buffer, this.reserveOffset + 4, 0, 3)
        this.extraNonce = 0
    }
    nextBlob() {
        this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset)
        return cnUtil.convert_blob(this.buffer, this.cnBlobType).toString("hex")
    }
}
