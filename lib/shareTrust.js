var minerShareTrust = { ip: {}, address: {} }
var logSystem = 'shareTrust'
var shareTrustConfig = global.config.poolServer.shareTrust
var shareTrustEnabled = shareTrustConfig && shareTrustConfig.enabled
var shareTrustProbabilityStepPercent = shareTrustEnabled ? shareTrustConfig.probabilityStepPercent / 100 : 0
var shareTrustMaxTrustPercent = shareTrustEnabled ? shareTrustConfig.maxTrustPercent / 100 : 0

process.on('message', function (message) {
  switch (message.type) {
    case 'shareTrust':
      setTrust(message.ip, message.address, message.shareValidated, true)
      break
  }
})

setInterval(function () {
  var dateNowSeconds = Date.now() / 1000 | 0

  if (shareTrustEnabled) {
    var maxShareTrustAge = shareTrustConfig.maxAge
    var ipTrustCount = 0
    var addressTrustCount = 0

    for (var ip in minerShareTrust.ip) {
      var minerShareTrustData = minerShareTrust.ip[ip]
      if (dateNowSeconds - minerShareTrustData.lastShareSeconds > maxShareTrustAge) {
        delete minerShareTrust.ip[ip]
        global.log('info', logSystem, 'ShareTrust data removed for ip %s', [ip])
      } else {
        if (minerShareTrust.ip[ip].trusted) { ipTrustCount++ }
      }
    }

    for (var address in minerShareTrust.address) {
      minerShareTrustData = minerShareTrust.address[address]
      if (dateNowSeconds - minerShareTrustData.lastShareSeconds > maxShareTrustAge) {
        delete minerShareTrust.address[address]
        global.log('info', logSystem, 'ShareTrust data removed for address %s', [address])
      } else {
        if (minerShareTrust.address[address].trusted) { addressTrustCount++ }
      }
    }

    global.log('info', logSystem, 'ShareTrust IP: Trusted: %s, Total: %s', [ipTrustCount, Object.keys(minerShareTrust.ip).length])
    global.log('info', logSystem, 'ShareTrust Address: Trusted: %s, Total: %s', [addressTrustCount, Object.keys(minerShareTrust.address).length])
  }
}, 300000)

function isTrusted (ip, address) {
  var shareTrustIP = minerShareTrust.ip[ip]
  var shareTrustAddress = minerShareTrust.address[address]
  if (shareTrustIP && shareTrustAddress) {
    return (shareTrustIP.trusted && shareTrustAddress.trusted)
  }
  return false
}

function checkTrust (ip, address, difficulty) {
  var dateNowSeconds = Date.now() / 1000 | 0
  var shareTrustIP = minerShareTrust.ip[ip]
  var shareTrustAddress = minerShareTrust.address[address]
  if (shareTrustIP && shareTrustAddress) {
    var rand = Math.random()
    var ipPastThresholds = dateNowSeconds - shareTrustIP.trustBeginSeconds > shareTrustIP.minUntrustedSeconds && shareTrustIP.untrustedShareThreshold <= 0
    var addressPastThresholds = dateNowSeconds - shareTrustAddress.trustBeginSeconds > shareTrustAddress.minUntrustedSeconds && shareTrustAddress.untrustedShareThreshold <= 0
    var inShareWindow = dateNowSeconds - shareTrustAddress.lastShareSeconds < shareTrustConfig.maxShareWindow && dateNowSeconds - shareTrustIP.lastShareSeconds < shareTrustConfig.maxShareWindow
    if (ipPastThresholds && addressPastThresholds && inShareWindow && shareTrustIP.trustProbability >= shareTrustMaxTrustPercent && shareTrustAddress.trustProbability >= shareTrustMaxTrustPercent) {
      if (!shareTrustIP.trusted || !shareTrustAddress.trusted) { global.log('info', logSystem, 'Miner is now share trusted %s@%s', [address, ip]) }
      shareTrustIP.trusted = shareTrustAddress.trusted = true
    }
    if ((difficulty < shareTrustConfig.maxTrustedDifficulty) && (inShareWindow) && (ipPastThresholds && rand < shareTrustIP.trustProbability) && (addressPastThresholds && rand < shareTrustAddress.trustProbability)) {
      return true
    }
  }
  return false
}

function setTrust (ip, address, shareValidated, isIPC) {
  var dateNowSeconds = Date.now() / 1000 | 0
  if (!minerShareTrust.ip[ip]) {
    minerShareTrust.ip[ip] = {
      untrustedShareThreshold: shareTrustConfig.minUntrustedShares,
      trustProbability: 0,
      minUntrustedSeconds: shareTrustConfig.minUntrustedSeconds,
      trustBeginSeconds: dateNowSeconds,
      currentPenaltyMultiplier: shareTrustConfig.minPenaltyMultiplier,
      lastShareSeconds: dateNowSeconds,
      penaltyStepUpBeginSeconds: dateNowSeconds,
      penaltyStepDownBeginSeconds: dateNowSeconds,
      probabilityStepWindowBeginSeconds: dateNowSeconds,
      ipcRateBeginSeconds: 0,
      trusted: false
    }
  }
  if (!minerShareTrust.address[address]) {
    minerShareTrust.address[address] = {
      untrustedShareThreshold: shareTrustConfig.minUntrustedShares,
      trustProbability: 0,
      minUntrustedSeconds: shareTrustConfig.minUntrustedSeconds,
      trustBeginSeconds: dateNowSeconds,
      currentPenaltyMultiplier: shareTrustConfig.minPenaltyMultiplier,
      lastShareSeconds: dateNowSeconds,
      penaltyStepUpBeginSeconds: dateNowSeconds,
      penaltyStepDownBeginSeconds: dateNowSeconds,
      probabilityStepWindowBeginSeconds: dateNowSeconds,
      ipcRateBeginSeconds: 0,
      trusted: false
    }
  }
  var shareTrustIP = minerShareTrust.ip[ip]
  var shareTrustAddress = minerShareTrust.address[address]
  if (isIPC === undefined) { isIPC = false }
  if (shareTrustIP && shareTrustAddress) {
    if (shareValidated) {
      if (dateNowSeconds - shareTrustAddress.lastShareSeconds >= shareTrustConfig.maxShareWindow || dateNowSeconds - shareTrustIP.lastShareSeconds >= shareTrustConfig.maxShareWindow) {
        if (shareTrustIP.untrustedShareThreshold < shareTrustConfig.minUntrustedShares) { shareTrustIP.untrustedShareThreshold = shareTrustConfig.minUntrustedShares }
        if (shareTrustAddress.untrustedShareThreshold < shareTrustConfig.minUntrustedShares) { shareTrustAddress.untrustedShareThreshold = shareTrustConfig.minUntrustedShares }
        shareTrustAddress.trustBeginSeconds = shareTrustIP.trustBeginSeconds = dateNowSeconds
        shareTrustIP.trustProbability = shareTrustAddress.trustProbability = 0
      }
      if (dateNowSeconds - shareTrustIP.probabilityStepWindowBeginSeconds > shareTrustConfig.probabilityStepWindow) {
        shareTrustIP.trustProbability += shareTrustProbabilityStepPercent
        shareTrustIP.probabilityStepWindowBeginSeconds = dateNowSeconds
      }
      if (dateNowSeconds - shareTrustAddress.probabilityStepWindowBeginSeconds > shareTrustConfig.probabilityStepWindow) {
        shareTrustAddress.trustProbability += shareTrustProbabilityStepPercent
        shareTrustAddress.probabilityStepWindowBeginSeconds = dateNowSeconds
      }
      if (shareTrustIP.currentPenaltyMultiplier > shareTrustConfig.minPenaltyMultiplier && dateNowSeconds - shareTrustIP.penaltyStepDownBeginSeconds > shareTrustConfig.penaltyStepDownWindow) {
        shareTrustIP.currentPenaltyMultiplier -= shareTrustConfig.penaltyMultiplierStep
        shareTrustIP.penaltyStepDownBeginSeconds = dateNowSeconds
      }
      if (shareTrustAddress.currentPenaltyMultiplier > shareTrustConfig.minPenaltyMultiplier && dateNowSeconds - shareTrustAddress.penaltyStepDownBeginSeconds > shareTrustConfig.penaltyStepDownWindow) {
        shareTrustAddress.currentPenaltyMultiplier -= shareTrustConfig.penaltyMultiplierStep
        shareTrustAddress.penaltyStepDownBeginSeconds = dateNowSeconds
      }
      if (shareTrustIP.trustProbability > shareTrustMaxTrustPercent) { shareTrustIP.trustProbability = shareTrustMaxTrustPercent }
      if (shareTrustAddress.trustProbability > shareTrustMaxTrustPercent) { shareTrustAddress.trustProbability = shareTrustMaxTrustPercent }
      if (shareTrustIP.untrustedShareThreshold > 0) { shareTrustIP.untrustedShareThreshold-- }
      if (shareTrustAddress.untrustedShareThreshold > 0) { shareTrustAddress.untrustedShareThreshold-- }
    } else {
      shareTrustIP.trustProbability = shareTrustAddress.trustProbability = 0
      shareTrustAddress.trustBeginSeconds = shareTrustIP.trustBeginSeconds = dateNowSeconds
      if (shareTrustIP.currentPenaltyMultiplier < shareTrustConfig.maxPenaltyMultiplier && dateNowSeconds - shareTrustIP.penaltyStepUpBeginSeconds > shareTrustConfig.penaltyStepUpWindow) {
        shareTrustIP.currentPenaltyMultiplier += shareTrustConfig.penaltyMultiplierStep
        shareTrustIP.penaltyStepUpBeginSeconds = dateNowSeconds
      }
      if (shareTrustAddress.currentPenaltyMultiplier < shareTrustConfig.maxPenaltyMultiplier && dateNowSeconds - shareTrustAddress.penaltyStepUpBeginSeconds > shareTrustConfig.penaltyStepUpWindow) {
        shareTrustAddress.currentPenaltyMultiplier += shareTrustConfig.penaltyMultiplierStep
        shareTrustAddress.penaltyStepUpBeginSeconds = dateNowSeconds
      }
      shareTrustIP.untrustedShareThreshold = (shareTrustConfig.minUntrustedShares * shareTrustIP.currentPenaltyMultiplier)
      shareTrustAddress.untrustedShareThreshold = (shareTrustConfig.minUntrustedShares * shareTrustAddress.currentPenaltyMultiplier)
      shareTrustIP.minUntrustedSeconds = (shareTrustConfig.minUntrustedSeconds * shareTrustIP.currentPenaltyMultiplier)
      shareTrustAddress.minUntrustedSeconds = (shareTrustConfig.minUntrustedSeconds * shareTrustAddress.currentPenaltyMultiplier)
      if (shareTrustIP.trusted && shareTrustAddress.trusted) { global.log('warn', logSystem, 'Share trust broken by %s@%s', [address, ip]) }
      shareTrustIP.trusted = shareTrustAddress.trusted = false

      if (isIPC) {
        shareTrustIP.ipcRateBeginSeconds = shareTrustAddress.ipcRateBeginSeconds = dateNowSeconds
      } else if (dateNowSeconds - shareTrustIP.ipcRateBeginSeconds > shareTrustConfig.maxIPCRate && dateNowSeconds - shareTrustIP.ipcRateBeginSeconds > shareTrustConfig.maxIPCRate) {
        shareTrustIP.ipcRateBeginSeconds = shareTrustAddress.ipcRateBeginSeconds = dateNowSeconds
        process.send({type: 'shareTrust', ip: ip, address: address, shareValidated: false})
      }
    }
    shareTrustAddress.lastShareSeconds = shareTrustIP.lastShareSeconds = dateNowSeconds
  }
}

module.exports = {
  enabled: shareTrustEnabled,
  isTrusted: isTrusted,
  checkTrust: checkTrust,
  setTrust: setTrust
}
