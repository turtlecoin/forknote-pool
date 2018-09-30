var cluster = require('cluster')
var os = require('os')
var redis = require('redis')

require('./lib/configReader.js')
require('./lib/logger.js')
global.redisClient = redis.createClient(global.config.redis.port, global.config.redis.host)

if (cluster.isWorker) {
  switch (process.env.workerType) {
    case 'pool':
      require('./lib/pool.js')
      break
    case 'blockUnlocker':
      require('./lib/blockUnlocker.js')
      break
    case 'paymentProcessor':
      require('./lib/paymentProcessor.js')
      break
    case 'api':
      require('./lib/api.js')
      break
    case 'cli':
      require('./lib/cli.js')
      break
    case 'chartsDataCollector':
      require('./lib/chartsDataCollector.js')
      break
  }
}

var logSystem = 'master'
require('./lib/exceptionWriter.js')(logSystem)

var singleModule = (function () {
  var validModules = ['pool', 'api', 'unlocker', 'payments', 'chartsDataCollector']

  for (var i = 0; i < process.argv.length; i++) {
    if (process.argv[i].indexOf('-module=') === 0) {
      var moduleName = process.argv[i].split('=')[1]
      if (validModules.indexOf(moduleName) > -1) { return moduleName }

      global.log('error', logSystem, 'Invalid module "%s", valid modules: %s', [moduleName, validModules.join(', ')])
      process.exit()
    }
  }
})();

(function init () {
  checkRedisVersion(function () {
    if (singleModule) {
      global.log('info', logSystem, 'Running in single module mode: %s', [singleModule])

      switch (singleModule) {
        case 'pool':
          spawnPoolWorkers()
          break
        case 'unlocker':
          spawnBlockUnlocker()
          break
        case 'payments':
          spawnPaymentProcessor()
          break
        case 'api':
          spawnApi()
          break
        case 'chartsDataCollector':
          spawnChartsDataCollector()
          break
      }
    } else {
      spawnPoolWorkers()
      spawnBlockUnlocker()
      spawnPaymentProcessor()
      spawnApi()
      spawnChartsDataCollector()
    }

    spawnCli()
  })
})()

function checkRedisVersion (callback) {
  global.redisClient.info(function (error, response) {
    if (error) {
      global.log('error', logSystem, 'Redis version check failed')
      return
    }
    var parts = response.split('\r\n')
    var version
    var versionString
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf(':') !== -1) {
        var valParts = parts[i].split(':')
        if (valParts[0] === 'redis_version') {
          versionString = valParts[1]
          version = parseFloat(versionString)
          break
        }
      }
    }
    if (!version) {
      global.log('error', logSystem, 'Could not detect redis version - must be super old or broken')
      return
    } else if (version < 2.6) {
      global.log('error', logSystem, "You're using redis version %s the minimum required version is 2.6. Follow the damn usage instructions...", [versionString])
      return
    }
    callback()
  })
}

function spawnPoolWorkers () {
  if (!global.config.poolServer || !global.config.poolServer.enabled || !global.config.poolServer.ports || global.config.poolServer.ports.length === 0) return

  if (global.config.poolServer.ports.length === 0) {
    global.log('error', logSystem, 'Pool server enabled but no ports specified')
    return
  }

  var numForks = (function () {
    if (!global.config.poolServer.clusterForks) { return 1 }
    if (global.config.poolServer.clusterForks === 'auto') { return os.cpus().length }
    if (isNaN(global.config.poolServer.clusterForks)) { return 1 }
    return global.config.poolServer.clusterForks
  })()

  var poolWorkers = {}

  var createPoolWorker = function (forkId) {
    var worker = cluster.fork({
      workerType: 'pool',
      forkId: forkId
    })
    worker.forkId = forkId
    worker.type = 'pool'
    poolWorkers[forkId] = worker
    worker.on('exit', function (code, signal) {
      global.log('error', logSystem, 'Pool fork %s died, spawning replacement worker...', [forkId])
      setTimeout(function () {
        createPoolWorker(forkId)
      }, 2000)
    }).on('message', function (msg) {
      switch (msg.type) {
        case 'banIP':
          Object.keys(cluster.workers).forEach(function (id) {
            if (cluster.workers[id].type === 'pool') {
              cluster.workers[id].send({type: 'banIP', ip: msg.ip})
            }
          })
          break
        case 'shareTrust':
          Object.keys(cluster.workers).forEach(function (id) {
            if (cluster.workers[id].type === 'pool' && cluster.workers[id].forkId !== worker.forkId) {
              cluster.workers[id].send({type: 'shareTrust', ip: msg.ip, address: msg.address, shareValidated: msg.shareValidated})
            }
          })
          break
      }
    })
  }

  var i = 1
  var spawnInterval = setInterval(function () {
    createPoolWorker(i.toString())
    i++
    if (i - 1 === numForks) {
      clearInterval(spawnInterval)
      global.log('info', logSystem, 'Pool spawned on %d thread(s)', [numForks])
    }
  }, 10)
}

function spawnBlockUnlocker () {
  if (!global.config.blockUnlocker || !global.config.blockUnlocker.enabled) return

  var worker = cluster.fork({
    workerType: 'blockUnlocker'
  })
  worker.on('exit', function (code, signal) {
    global.log('error', logSystem, 'Block unlocker died, spawning replacement...')
    setTimeout(function () {
      spawnBlockUnlocker()
    }, 2000)
  })
}

function spawnPaymentProcessor () {
  if (!global.config.payments || !global.config.payments.enabled) return

  var worker = cluster.fork({
    workerType: 'paymentProcessor'
  })
  worker.on('exit', function (code, signal) {
    global.log('error', logSystem, 'Payment processor died, spawning replacement...')
    setTimeout(function () {
      spawnPaymentProcessor()
    }, 2000)
  })
}

function spawnApi () {
  if (!global.config.api || !global.config.api.enabled) return

  var worker = cluster.fork({
    workerType: 'api'
  })
  worker.on('exit', function (code, signal) {
    global.log('error', logSystem, 'API died, spawning replacement...')
    setTimeout(function () {
      spawnApi()
    }, 2000)
  })
}

function spawnCli () {

}

function spawnChartsDataCollector () {
  if (!global.config.charts) return

  var worker = cluster.fork({
    workerType: 'chartsDataCollector'
  })
  worker.on('exit', function (code, signal) {
    global.log('error', logSystem, 'chartsDataCollector died, spawning replacement...')
    setTimeout(function () {
      spawnChartsDataCollector()
    }, 2000)
  })
}
