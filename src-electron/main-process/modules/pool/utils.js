const crypto = require("crypto")
const BigInt = require("big-integer")

export const noncePattern = new RegExp("^[0-9A-Fa-f]{8}$")

//export const diff1 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
export const diff1 = BigInt("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", 16)


export function instanceId() {
    return crypto.randomBytes(4)
}

export function cleanupSpecialChars(str) {
    str = str.replace(/[ÀÁÂÃÄÅ]/g,"A")
    str = str.replace(/[àáâãäå]/g,"a")
    str = str.replace(/[ÈÉÊË]/g,"E")
    str = str.replace(/[èéêë]/g,"e")
    str = str.replace(/[ÌÎÏ]/g,"I")
    str = str.replace(/[ìîï]/g,"i")
    str = str.replace(/[ÒÔÖ]/g,"O")
    str = str.replace(/[òôö]/g,"o")
    str = str.replace(/[ÙÛÜ]/g,"U")
    str = str.replace(/[ùûü]/g,"u")
    return str.replace(/[^A-Za-z0-9\-\_]/gi,'')
}

export function uid() {
    var min = 100000000000000
    var max = 999999999999999
    var id = Math.floor(Math.random() * (max - min + 1)) + min
    return id.toString()
}
