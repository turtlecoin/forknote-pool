const net = require('net')
const crypto = require('crypto')
const Buffer = require('safe-buffer').Buffer
const async = require('async')
const bignum = require('big-integer')
const cnUtil = require('turtlecoin-cryptonote-util')
const TurtleCoinUtils = require('turtlecoin-utils')
const turtleUtil = new TurtleCoinUtils.CryptoNote()
const Crypto = new TurtleCoinUtils.Crypto()
const Address = TurtleCoinUtils.Address

// Must exactly be 8 hex chars
const noncePattern = new RegExp('^[0-9A-Fa-f]{8}$')

const threadId = '(Thread ' + process.env.forkId + ') '

const logSystem = 'pool'
require('./exceptionWriter.js')(logSystem)

const shareTrust = require('./shareTrust.js')
const apiInterfaces = require('./apiInterfaces.js')(global.config.daemon, global.config.wallet, global.config.api)
const utils = require('./utils.js')
Buffer.prototype.toByteArray = function () { return Array.prototype.slice.call(this, 0) }

const log = function (severity, system, text, data) {
  global.log(severity, system, threadId + text, data)
}

const cryptoNight = Crypto.cn_slow_hash_v0
const cryptoNightLite = Crypto.cn_lite_slow_hash_v1
const cryptoNightTurtleLite = Crypto.cn_turtle_lite_slow_hash_v2
const chukwa = Crypto.chukwa_slow_hash_v1
const chukwav2 = Crypto.chukwa_slow_hash_v2

const diff1 = bignum('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16)

const instanceId = crypto.randomBytes(4)

const validBlockTemplates = []
let currentBlockTemplate

// Vars for slush mining
let scoreTime
let lastChecked = 0

const connectedMiners = {}

const bannedIPs = {}
const perIPStats = {}

const banningEnabled = global.config.poolServer.banning && global.config.poolServer.banning.enabled

const addressBase58Prefix = cnUtil.address_decode(Buffer.from(global.config.poolServer.poolAddress))

try {
  const poolAddress = Address.fromAddress(global.config.poolServer.poolAddress, addressBase58Prefix)
  if (!poolAddress) throw new Error('Could not decode address')
} catch (e) {
  log('error', logSystem, 'Pool server address is invalid', [global.config.poolServer.poolAddress])
  process.exit(1)
}

setInterval(function () {
  const now = Date.now() / 1000 | 0
  for (const minerId in connectedMiners) {
    const miner = connectedMiners[minerId]
    if (!miner.noRetarget) {
      miner.retarget(now)
    }
  }
}, global.config.poolServer.varDiff.retargetTime * 1000)

/* Every 30 seconds clear out timed-out miners and old bans */
setInterval(function () {
  const now = Date.now()
  const timeout = global.config.poolServer.minerTimeout * 1000
  for (const minerId in connectedMiners) {
    const miner = connectedMiners[minerId]
    if (now - miner.lastBeat > timeout) {
      log('warn', logSystem, 'Miner timed out and disconnected %s@%s', [miner.login, miner.ip])
      delete connectedMiners[minerId]
    }
  }

  if (banningEnabled) {
    for (const ip in bannedIPs) {
      const banTime = bannedIPs[ip]
      if (now - banTime > global.config.poolServer.banning.time * 1000) {
        delete bannedIPs[ip]
        delete perIPStats[ip]
        log('info', logSystem, 'Ban dropped for %s', [ip])
      }
    }
  }
}, 30000)

process.on('message', function (message) {
  switch (message.type) {
    case 'banIP':
      bannedIPs[message.ip] = Date.now()
      break
  }
})

function IsBannedIp (ip) {
  if (!banningEnabled || !bannedIPs[ip]) return false

  const bannedTime = bannedIPs[ip]
  const bannedTimeAgo = Date.now() - bannedTime
  const timeLeft = global.config.poolServer.banning.time * 1000 - bannedTimeAgo
  if (timeLeft > 0) {
    return true
  } else {
    delete bannedIPs[ip]
    log('info', logSystem, 'Ban dropped for %s', [ip])
    return false
  }
}

function BlockTemplate (template) {
  this.blob = template.blocktemplate_blob
  this.difficulty = template.difficulty
  this.height = template.height
  this.reserveOffset = template.reserved_offset
  this.buffer = Buffer.from(this.blob, 'hex')
  instanceId.copy(this.buffer, this.reserveOffset + 4, 0, 3)
  this.extraNonce = 0
}
BlockTemplate.prototype = {
  nextBlob: function () {
    this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset)
    return cnUtil.convert_blob(this.buffer).toString('hex')
  }
}

function getBlockTemplate (callback) {
  apiInterfaces.rpcDaemon('getblocktemplate', { reserve_size: 8, wallet_address: global.config.poolServer.poolAddress }, callback)
}

function jobRefresh (loop, callback) {
  callback = callback || function (val) {}
  getBlockTemplate(function (error, result) {
    if (loop) {
      setTimeout(function () {
        jobRefresh(true)
      }, global.config.poolServer.blockRefreshInterval)
    }
    if (error) {
      log('error', logSystem, 'Error polling getblocktemplate %j', [error])
      callback(false)
      return
    }
    if (!currentBlockTemplate || result.height > currentBlockTemplate.height) {
      log('info', logSystem, 'New block to mine at height %d w/ difficulty of %d', [result.height, result.difficulty])
      processBlockTemplate(result)
    }
    callback(true)
  })
}

function processBlockTemplate (template) {
  if (currentBlockTemplate) { validBlockTemplates.push(currentBlockTemplate) }

  if (validBlockTemplates.length > 3) { validBlockTemplates.shift() }

  currentBlockTemplate = new BlockTemplate(template)

  for (const minerId in connectedMiners) {
    const miner = connectedMiners[minerId]
    miner.pushMessage('job', miner.getJob())
  }
}

(function init () {
  jobRefresh(true, function (sucessful) {
    if (!sucessful) {
      log('error', logSystem, 'Could not start pool')
      process.exit()
    }
    startPoolServerTcp(function (successful) {

    })
  })
})()

const VarDiff = (function () {
  const letiance = global.config.poolServer.varDiff.letiancePercent / 100 * global.config.poolServer.varDiff.targetTime
  return {
    letiance: letiance,
    bufferSize: global.config.poolServer.varDiff.retargetTime / global.config.poolServer.varDiff.targetTime * 4,
    tMin: global.config.poolServer.varDiff.targetTime - letiance,
    tMax: global.config.poolServer.varDiff.targetTime + letiance,
    maxJump: global.config.poolServer.varDiff.maxJump
  }
})()

function Miner (id, login, workerName, pass, ip, startingDiff, noRetarget, pushMessage) {
  this.id = id
  this.login = login
  this.pass = pass
  this.ip = ip
  this.pushMessage = pushMessage
  this.heartbeat()
  this.noRetarget = noRetarget
  this.difficulty = startingDiff
  this.workerName = workerName
  this.validJobs = []

  // Vardiff related letiables
  this.shareTimeRing = utils.ringBuffer(16)
  this.lastShareTime = Date.now() / 1000 | 0
}
Miner.prototype = {
  retarget: function (now) {
    const options = global.config.poolServer.varDiff

    const sinceLast = now - this.lastShareTime
    const decreaser = sinceLast > VarDiff.tMax

    const avg = this.shareTimeRing.avg(decreaser ? sinceLast : null)
    let newDiff

    let direction

    if (avg > VarDiff.tMax && this.difficulty > options.minDiff) {
      newDiff = options.targetTime / avg * this.difficulty
      newDiff = newDiff > options.minDiff ? newDiff : options.minDiff
      direction = -1
    } else if (avg < VarDiff.tMin && this.difficulty < options.maxDiff) {
      newDiff = options.targetTime / avg * this.difficulty
      newDiff = newDiff < options.maxDiff ? newDiff : options.maxDiff
      direction = 1
    } else {
      return
    }

    if (Math.abs(newDiff - this.difficulty) / this.difficulty * 100 > options.maxJump) {
      const change = options.maxJump / 100 * this.difficulty * direction
      newDiff = this.difficulty + change
    }

    this.setNewDiff(newDiff)
    this.shareTimeRing.clear()
    if (decreaser) this.lastShareTime = now
  },
  setNewDiff: function (newDiff) {
    newDiff = Math.round(newDiff)
    if (this.difficulty === newDiff) return
    log('info', logSystem, 'Retargetting difficulty %d to %d for %s', [this.difficulty, newDiff, this.login])
    this.pendingDifficulty = newDiff
    this.pushMessage('job', this.getJob())
  },
  heartbeat: function () {
    this.lastBeat = Date.now()
  },
  getTargetHex: function () {
    if (this.pendingDifficulty) {
      this.lastDifficulty = this.difficulty
      this.difficulty = this.pendingDifficulty
      this.pendingDifficulty = null
    }

    const padded = Buffer.alloc(32)

    const diffBuff = diff1.div(this.difficulty).toBuffer()
    diffBuff.copy(padded, 32 - diffBuff.length)

    const buff = padded.slice(0, 4)
    const buffArray = buff.toByteArray().reverse()
    const buffReversed = Buffer.from(buffArray)
    this.target = buffReversed.readUInt32BE(0)
    const hex = buffReversed.toString('hex')
    return hex
  },
  getJob: function () {
    if (this.lastBlockHeight === currentBlockTemplate.height && !this.pendingDifficulty) {
      return {
        blob: '',
        job_id: '',
        target: ''
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
      score: this.score,
      diffHex: this.diffHex,
      submissions: []
    }

    this.validJobs.push(newJob)

    if (this.validJobs.length > 4) { this.validJobs.shift() }

    const blockTemplate = Buffer.from(currentBlockTemplate.blob, 'hex')
    const rootBlockTemplate = Buffer.from(blob, 'hex')

    const jobData = {
      blob: blob,
      job_id: newJob.id,
      target: target,
      height: currentBlockTemplate.height,
      blockMajorVersion: blockTemplate[0],
      blockMinorVersion: blockTemplate[1],
      rootMajorVersion: rootBlockTemplate[0],
      rootMinorVersion: rootBlockTemplate[1]
    }

    return jobData
  },
  checkBan: function (validShare) {
    if (!banningEnabled) return

    // Init global per-IP shares stats
    if (!perIPStats[this.ip]) {
      perIPStats[this.ip] = { validShares: 0, invalidShares: 0 }
    }

    const stats = perIPStats[this.ip]
    validShare ? stats.validShares++ : stats.invalidShares++
    if (stats.validShares + stats.invalidShares >= global.config.poolServer.banning.checkThreshold) {
      if (stats.invalidShares / (stats.invalidShares + stats.validShares) >= global.config.poolServer.banning.invalidPercent / 100) {
        log('warn', logSystem, 'Banned %s@%s', [this.login, this.ip])
        bannedIPs[this.ip] = Date.now()
        delete connectedMiners[this.id]
        process.send({ type: 'banIP', ip: this.ip })
      } else {
        stats.invalidShares = 0
        stats.validShares = 0
      }
    }
  }
}

function recordShareData (miner, job, shareDiff, blockCandidate, hashHex, shareType, blockTemplate) {
  const dateNow = Date.now()
  const dateNowSeconds = dateNow / 1000 | 0

  // Weighting older shares lower than newer ones to prevent pool hopping
  if (global.config.poolServer.slushMining.enabled) {
    if (lastChecked + global.config.poolServer.slushMining.lastBlockCheckRate <= dateNowSeconds || lastChecked === 0) {
      global.redisClient.hget(global.config.coin + ':stats', 'lastBlockFound', function (error, result) {
        if (error) {
          log('error', logSystem, 'Unable to determine the timestamp of the last block found')
          return
        }
        scoreTime = result / 1000 | 0 // scoreTime could potentially be something else than the beginning of the current round, though this would warrant changes in api.js (and potentially the redis db)
        lastChecked = dateNowSeconds
      })
    }

    job.score = job.difficulty * Math.pow(Math.E, ((scoreTime - dateNowSeconds) / global.config.poolServer.slushMining.weight)) // Score Calculation
    log('info', logSystem, 'Submitted score ' + job.score + ' with difficulty ' + job.difficulty + ' and the time ' + scoreTime)
  } else {
    job.score = job.difficulty
  }

  const redisCommands = [
    ['hincrby', global.config.coin + ':shares:roundCurrent', miner.login, job.score],
    ['zadd', global.config.coin + ':hashrate', dateNowSeconds, [job.difficulty, miner.login + '+' + miner.workerName, dateNow].join(':')],
    ['hincrby', global.config.coin + ':workers:' + miner.login, 'hashes', job.difficulty],
    ['hset', global.config.coin + ':workers:' + miner.login, 'lastShare', dateNowSeconds]
  ]

  if (blockCandidate) {
    redisCommands.push(['hset', global.config.coin + ':stats', 'lastBlockFound', Date.now()])
    redisCommands.push(['rename', global.config.coin + ':shares:roundCurrent', global.config.coin + ':shares:round' + job.height])
    redisCommands.push(['hgetall', global.config.coin + ':shares:round' + job.height])
  }

  global.redisClient.multi(redisCommands).exec(function (err, replies) {
    if (err) {
      log('error', logSystem, 'Failed to insert share data into redis %j \n %j', [err, redisCommands])
      return
    }
    if (blockCandidate) {
      const workerShares = replies[replies.length - 1]
      const totalShares = Object.keys(workerShares).reduce(function (p, c) {
        return p + parseInt(workerShares[c])
      }, 0)
      global.redisClient.zadd(global.config.coin + ':blocks:candidates', job.height, [
        hashHex,
        Date.now() / 1000 | 0,
        blockTemplate.difficulty,
        totalShares
      ].join(':'), function (err, result) {
        if (err) {
          log('error', logSystem, 'Failed inserting block candidate %s \n %j', [hashHex, err])
        }
      })
    }
  })

  log('info', logSystem, 'Accepted %s share at difficulty %d/%d from %s@%s', [shareType, job.difficulty, shareDiff, miner.login, miner.ip])
}

function processShare (miner, job, blockTemplate, nonce, resultHash) {
  const template = Buffer.from(blockTemplate.buffer.length)
  blockTemplate.buffer.copy(template)
  template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset)
  const shareBuffer = cnUtil.construct_block_blob(template, Buffer.from(nonce, 'hex'))

  log('info', logSystem, 'Processing block v%d.%d share for %s@%s at height %d', [shareBuffer[0], shareBuffer[1], miner.login, miner.ip, job.height])

  let convertedBlob
  let hash
  let shareType

  if (shareTrust.enabled && shareTrust.checkTrust(miner.ip, miner.login, job.difficulty)) {
    hash = Buffer.from(resultHash, 'hex')
    shareType = 'trusted'
  } else {
    convertedBlob = cnUtil.convert_blob(shareBuffer)
    if (shareBuffer[0] >= 7) {
      hash = chukwav2(convertedBlob)
    } else if (shareBuffer[0] === 6) {
      hash = chukwa(convertedBlob)
    } else if (shareBuffer[0] === 5) {
      hash = cryptoNightTurtleLite(convertedBlob, 2)
    } else if (shareBuffer[0] === 4) {
      hash = cryptoNightLite(convertedBlob, 1)
    } else {
      hash = cryptoNight(convertedBlob)
    }
    shareType = 'valid'
  }

  if (hash.toString('hex') !== resultHash) {
    log('warn', logSystem, 'Bad hash from miner %s@%s', [miner.login, miner.ip])
    if (shareTrust.enabled) { shareTrust.setTrust(miner.ip, miner.login, false) }
    return false
  }

  const hashArray = hash.toByteArray().reverse()
  const hashNum = bignum(Buffer.from(hashArray).toString('hex'), 16)
  const hashDiff = diff1.divide(hashNum)

  if (hashDiff.greaterOrEquals(blockTemplate.difficulty)) {
    apiInterfaces.rpcDaemon('submitblock', [shareBuffer.toString('hex')], function (error, result) {
      if (error) {
        log('error', logSystem, 'Error submitting block at height %d from %s@%s, share type: "%s" - %j', [job.height, miner.login, miner.ip, shareType, error])
        recordShareData(miner, job, hashDiff.toString(), false, null, shareType)
      } else {
        const blockFastHash = cnUtil.get_block_id(shareBuffer).toString('hex')
        log('info', logSystem,
          'Block %s found at height %d by miner %s@%s - submit result: %j',
          [blockFastHash.substr(0, 6), job.height, miner.login, miner.ip, result]
        )
        recordShareData(miner, job, hashDiff.toString(), true, blockFastHash, shareType, blockTemplate)
        jobRefresh()
      }
    })
  } else if (hashDiff.lt(job.difficulty)) {
    log('warn', logSystem, 'Rejected low difficulty share of %s from %s@%s', [hashDiff.toString(), miner.login, miner.ip])
    if (shareTrust.enabled) { shareTrust.setTrust(miner.ip, miner.login, false) }
    return false
  } else {
    recordShareData(miner, job, hashDiff.toString(), false, null, shareType)
  }

  if (shareTrust.enabled && shareType === 'valid') { shareTrust.setTrust(miner.ip, miner.login, true) }

  return true
}

function handleMinerMethod (method, params, ip, portData, sendReply, pushMessage) {
  if (typeof params.id === 'undefined' && method !== 'login') {
    /* The id should always be defined after login, if it
       is not that means that the miner is not obeying the
       rules of the protocol and needs banned */

    log('error', logSystem, 'Miner at %s sent a bad parameter set', [ip])
    process.send({ type: 'banIP', ip: ip })
    return
  } else if (typeof params.id !== 'undefined' && method !== 'login') {
    const miner = connectedMiners[params.id]
    if (typeof miner === 'undefined') {
      log('error', logSystem, 'Miner for %s not found in our connected miner list', [ip])
      return
    }
  }

  // Check for ban here, so preconnected attackers can't continue to screw you
  if (IsBannedIp(ip)) {
    sendReply('your IP is banned')
    return
  }

  switch (method) {
    case 'login':
      let login = params.login
      if (!login) {
        sendReply('missing login')
        return
      }

      let difficulty = portData.difficulty
      let workerName = 'unknown'
      let noRetarget = false
      let paymentId = ''

      /* Let's look for a worker name */
      let loginParts = login.split('+')

      /* If we split this okay, then the worker name is at the end */
      if (loginParts.length === 2) {
        workerName = loginParts[1]
        log('info', logSystem, 'Miner %s uses worker name: %s', [loginParts[0], workerName])
      }

      /* We'll stick the rest back in the login letiable */
      login = loginParts[0]

      /* Now we need to look for other stuff like a fixed difficulty,
         payment id, etc */
      loginParts = login.split(global.config.poolServer.fixedDiff.addressSeparator)

      /* If there is more than one segment, then we've got some work to do */
      if (loginParts.length >= 2) {
        for (let i = 1; i < loginParts.length; i++) {
          const part = loginParts[i]
          if (toNumber(part) && global.config.poolServer.fixedDiff.enabled) {
            /* This is a number so it's probably a fixed diff */
            noRetarget = true
            difficulty = toNumber(part)
            log('info', logSystem, 'Miner difficulty fixed to %s', [difficulty])
          } else if (isPaymentId(part) && global.config.payments.allowPaymentId) {
            /* Is this a payment ID? (hex 64-chars) */
            paymentId = part
          }
        }
      }

      /* We'll stick the rest back in the login letiable */
      login = loginParts[0]

      let minerAddress
      try {
        /* This method will check to verify not only that the address
           is a valid address, but also that it matches the address
           prefix of the pool server itself */
        minerAddress = turtleUtil.decodeAddress(login, addressBase58Prefix)
        if (paymentId.length !== 0) {
          /* If the miner supplied a different payment id in their
             login information, we're going to overwrite what we
             found in the integrated address */
          minerAddress.paymentId = paymentId
        }
        if (minerAddress.paymentId.length !== 0) {
          log('info', logSystem, 'Miner submitted payment ID %s', [minerAddress.paymentId])
        }
      } catch (e) {
        sendReply('invalid address used for login')
        return
      }

      /* Check to see if we support mining to a payment ID and if not and
         the miner tried to sneak one through, we're going to kick back that
         they can not do that here */
      if (!global.config.payments.allowPaymentId && minerAddress.paymentId.length !== 0) {
        sendReply('mining to an address with a payment id is not supported here')
        return
      }

      /* Rebuild the miner address for the login (due to payment ids) */
      login = turtleUtil.encodeAddress(minerAddress.publicViewKey, minerAddress.publicSpendKey, minerAddress.paymentId, addressBase58Prefix)

      if (IsBannedIp(ip)) {
        sendReply('your IP is banned')
        return
      }

      const minerId = utils.uid()
      miner = new Miner(minerId, login, workerName, params.pass, ip, difficulty, noRetarget, pushMessage)
      connectedMiners[minerId] = miner
      sendReply(null, {
        id: minerId,
        job: miner.getJob(),
        status: 'OK'
      })
      log('info', logSystem, 'Miner connected %s@%s', [login, miner.ip])
      break

    case 'getjob':
      if (!miner) {
        sendReply('Unauthenticated')
        return
      }
      miner.heartbeat()
      sendReply(null, miner.getJob())
      break
    case 'submit':
      if (!miner) {
        sendReply('Unauthenticated')
        return
      }
      miner.heartbeat()

      const job = miner.validJobs.filter(function (job) {
        return job.id === params.job_id
      })[0]

      if (!job) {
        sendReply('Invalid job id')
        return
      }

      params.nonce = params.nonce.substr(0, 8).toLowerCase()
      if (!noncePattern.test(params.nonce)) {
        const minerText = miner ? (' ' + miner.login + '@' + miner.ip) : ''
        log('warn', logSystem, 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + minerText)
        if (!perIPStats[miner.ip]) {
          perIPStats[miner.ip] = { validShares: 0, invalidShares: 0 }
        }
        perIPStats[miner.ip].invalidShares += Math.floor((global.config.poolServer.banning.checkThreshold / 4) * (global.config.poolServer.banning.invalidPercent / 100) - 1)
        miner.checkBan(false)
        sendReply('Malformed nonce')
        return
      } else if (job.submissions.indexOf(params.nonce) !== -1) {
        minerText = miner ? (' ' + miner.login + '@' + miner.ip) : ''
        log('warn', logSystem, 'Duplicate share: ' + JSON.stringify(params) + ' from ' + minerText)
        if (!perIPStats[miner.ip]) {
          perIPStats[miner.ip] = { validShares: 0, invalidShares: 0 }
        }
        perIPStats[miner.ip].invalidShares += Math.floor((global.config.poolServer.banning.checkThreshold / 4) * (global.config.poolServer.banning.invalidPercent / 100) - 1)
        miner.checkBan(false)
        sendReply('Duplicate share')
        return
      }

      job.submissions.push(params.nonce)

      const blockTemplate = currentBlockTemplate.height === job.height ? currentBlockTemplate : validBlockTemplates.filter(function (t) {
        return t.height === job.height
      })[0]

      if (!blockTemplate) {
        sendReply('Block expired')
        return
      }

      const shareAccepted = processShare(miner, job, blockTemplate, params.nonce, params.result)
      miner.checkBan(shareAccepted)

      if (!shareAccepted) {
        sendReply('Low difficulty share')
        return
      }

      const now = Date.now() / 1000 | 0
      miner.shareTimeRing.append(now - miner.lastShareTime)
      miner.lastShareTime = now
      // miner.retarget(now);

      sendReply(null, { status: 'OK' })
      break
    case 'keepalived' :
      if (!miner) {
        sendReply('Unauthenticated')
        return
      }
      miner.heartbeat()
      sendReply(null, { status: 'KEEPALIVED' })
      break
    default:
      sendReply('invalid method')
      minerText = miner ? (' ' + miner.login + '@' + miner.ip) : ''
      log('warn', logSystem, 'Invalid method: %s (%j) from %s', [method, params, minerText])
      break
  }
}

const httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 20\n\nmining server online'

function startPoolServerTcp (callback) {
  async.each(global.config.poolServer.ports, function (portData, cback) {
    const handleMessage = function (socket, jsonData, pushMessage) {
      if (!jsonData.id) {
        log('warn', logSystem, 'Miner RPC request missing RPC id')
        return
      } else if (!jsonData.method) {
        log('warn', logSystem, 'Miner RPC request missing RPC method')
        return
      } else if (!jsonData.params) {
        log('warn', logSystem, 'Miner RPC request missing RPC params object')
        return
      }

      const sendReply = function (error, result) {
        if (!socket.writable) return
        const sendData = JSON.stringify({
          id: jsonData.id,
          jsonrpc: '2.0',
          error: error ? { code: -1, message: error } : null,
          result: result
        }) + '\n'
        socket.write(sendData)
      }

      handleMinerMethod(jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, pushMessage)
    }

    net.createServer(function (socket) {
      if (banningEnabled && socket.remoteAddress !== 'undefined' && bannedIPs[socket.remoteAddress]) {
        log('warn', logSystem, 'Connection prevented from banned ip %s', [socket.remoteAddress])
        bannedIPs[socket.remoteAddress] = Date.now()
        socket.destroy()
        return
      }

      socket.setKeepAlive(true)
      socket.setEncoding('utf8')

      let dataBuffer = ''

      let pushMessage = function (method, params) {
        if (!socket.writable) return
        const sendData = JSON.stringify({
          jsonrpc: '2.0',
          method: method,
          params: params
        }) + '\n'
        socket.write(sendData)
      }

      socket.on('data', function (d) {
        dataBuffer += d
        if (Buffer.byteLength(dataBuffer, 'utf8') > 10240) { // 10KB
          dataBuffer = null
          log('warn', logSystem, 'Socket flooding detected and prevented from %s', [socket.remoteAddress])
          socket.destroy()
          return
        }
        if (dataBuffer.indexOf('\n') !== -1) {
          const messages = dataBuffer.split('\n')
          const incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop()
          for (let i = 0; i < messages.length; i++) {
            const message = messages[i]
            if (message.trim() === '') continue
            let jsonData
            try {
              jsonData = JSON.parse(message)
            } catch (e) {
              if (message.indexOf('GET /') === 0) {
                if (message.indexOf('HTTP/1.1') !== -1) {
                  socket.end('HTTP/1.1' + httpResponse)
                  break
                } else if (message.indexOf('HTTP/1.0') !== -1) {
                  socket.end('HTTP/1.0' + httpResponse)
                  break
                }
              }

              log('warn', logSystem, 'Malformed message from %s: %s', [socket.remoteAddress, message])
              socket.destroy()

              break
            }
            handleMessage(socket, jsonData, pushMessage)
          }
          dataBuffer = incomplete
        }
      }).on('error', function (err) {
        if (err.code !== 'ECONNRESET') { log('warn', logSystem, 'Socket error from %s %j', [socket.remoteAddress, err]) }
      }).on('close', function () {
        pushMessage = function () {}
      })
    }).listen(portData.port, function (error, result) {
      if (error) {
        log('error', logSystem, 'Could not start server listening on port %d, error: $j', [portData.port, error])
        cback(true)
        return
      }
      log('info', logSystem, 'Started server listening on port %d', [portData.port])
      cback()
    })
  }, function (err) {
    if (err) { callback(false) } else { callback(true) }
  })
}

/* This is a special magic function to make sure that when
   we parse a number that the whole thing is actually a
   number */
function toNumber (term) {
  if (typeof term === 'number') {
    return term
  }
  if (parseInt(term).toString() === term) {
    return parseInt(term)
  } else {
    return false
  }
}

function isPaymentId (str) {
  const regex = new RegExp('^[0-9a-fA-F]{64}$')
  return regex.test(str)
}
