var async = require('async')
var apiInterfaces = require('./apiInterfaces.js')(global.config.daemon, global.config.wallet, global.config.api)

var logSystem = 'charts'
require('./exceptionWriter.js')(logSystem)

global.log('info', logSystem, 'Started')

function startDataCollectors () {
  async.each(Object.keys(global.config.charts.pool), function (chartName) {
    var settings = global.config.charts.pool[chartName]
    if (settings.enabled) {
      setInterval(function () {
        collectPoolStatWithInterval(chartName, settings)
      }, settings.updateInterval * 1000)
    }
  })

  var settings = global.config.charts.user.hashrate
  if (settings.enabled) {
    setInterval(function () {
      collectUsersHashrate('hashrate', settings)
    }, settings.updateInterval * 1000)
  }
}

function getChartDataFromRedis (chartName, callback) {
  global.redisClient.get(getStatsRedisKey(chartName), function (error, data) {
    global.log('info', logSystem, 'Error getting chart data from Redis: %s', [error])
    callback(data ? JSON.parse(data) : [])
  })
}

function getUserHashrateChartData (address, callback) {
  getChartDataFromRedis('hashrate:' + address, callback)
}

function convertPaymentsDataToChart (paymentsData) {
  var data = []
  if (paymentsData && paymentsData.length) {
    for (var i = 0; paymentsData[i]; i += 2) {
      data.unshift([+paymentsData[i + 1], paymentsData[i].split(':')[1]])
    }
  }
  return data
}

function getUserChartsData (address, paymentsData, callback) {
  var chartsFuncs = {
    hashrate: function (callback) {
      getUserHashrateChartData(address, function (data) {
        callback(null, data)
      })
    },

    payments: function (callback) {
      callback(null, convertPaymentsDataToChart(paymentsData))
    }
  }
  for (var chartName in chartsFuncs) {
    if (!global.config.charts.user[chartName].enabled) {
      delete chartsFuncs[chartName]
    }
  }
  async.parallel(chartsFuncs, callback)
}

function getUserWorkerChartsData (address, paymentsData, callback) {
  var chartsFuncs = {
    hashrate: function (callback) {
      getUserHashrateChartData(address, function (data) {
        callback(null, data)
      })
    }
  }
  for (var chartName in chartsFuncs) {
    if (!global.config.charts.user[chartName].enabled) {
      delete chartsFuncs[chartName]
    }
  }
  async.parallel(chartsFuncs, callback)
}

function getStatsRedisKey (chartName) {
  return global.config.coin + ':charts:' + chartName
}

var chartStatFuncs = {
  hashrate: getPoolHashrate,
  workers: getPoolWorkers,
  difficulty: getNetworkDifficulty,
  price: getCoinPrice,
  profit: getCoinProfit
}

var statValueHandler = {
  avg: function (set, value) {
    set[1] = (set[1] * set[2] + value) / (set[2] + 1)
  },
  avgRound: function (set, value) {
    statValueHandler.avg(set, value)
    set[1] = Math.round(set[1])
  },
  max: function (set, value) {
    if (value > set[1]) {
      set[1] = value
    }
  }
}

var preSaveFunctions = {
  hashrate: statValueHandler.avgRound,
  workers: statValueHandler.max,
  difficulty: statValueHandler.avgRound,
  price: statValueHandler.avg,
  profit: statValueHandler.avg
}

function storeCollectedValues (chartName, values, settings) {
  for (var i in values) {
    storeCollectedValue(chartName + ':' + i, values[i], settings)
  }
}

function storeCollectedValue (chartName, value, settings) {
  var now = new Date() / 1000 | 0
  getChartDataFromRedis(chartName, function (sets) {
    var lastSet = sets[sets.length - 1] // [time, avgValue, updatesCount]
    if (!lastSet || now - lastSet[0] > settings.stepInterval) {
      lastSet = [now, value, 1]
      sets.push(lastSet)
      while (now - sets[0][0] > settings.maximumPeriod) { // clear old sets
        sets.shift()
      }
    } else {
      preSaveFunctions[chartName]
        ? preSaveFunctions[chartName](lastSet, value)
        : statValueHandler.avgRound(lastSet, value)
      lastSet[2]++
    }
    global.redisClient.set(getStatsRedisKey(chartName), JSON.stringify(sets))
    global.log('info', logSystem, chartName + ' chart collected value ' + value + '. Total sets count ' + sets.length)
  })
}

function collectPoolStatWithInterval (chartName, settings) {
  async.waterfall([
    chartStatFuncs[chartName],
    function (value, callback) {
      storeCollectedValue(chartName, value, settings, callback)
    }
  ])
}

function getPoolStats (callback) {
  apiInterfaces.pool('/stats', callback)
}

function getPoolHashrate (callback) {
  getPoolStats(function (error, stats) {
    callback(error, stats.pool ? Math.round(stats.pool.hashrate) : null)
  })
}

function getPoolWorkers (callback) {
  getPoolStats(function (error, stats) {
    callback(error, stats.pool ? stats.pool.miners : null)
  })
}

function getNetworkDifficulty (callback) {
  getPoolStats(function (error, stats) {
    callback(error, stats.pool ? stats.network.difficulty : null)
  })
}

function getUsersHashrates (callback) {
  var method = '/miners_hashrate?password=' + global.config.api.password
  apiInterfaces.pool(method, function (error, data) {
    global.log('info', logSystem, 'Error getting user hashrates: %s', [error])
    callback(data.minersHashrate)
  })
}

function collectUsersHashrate (chartName, settings) {
  var redisBaseKey = getStatsRedisKey(chartName) + ':'
  global.redisClient.keys(redisBaseKey + '*', function (keys) { // turtlecoin:charts:hashrate:*
    var hashrates = {}
    for (var i in keys) {
      hashrates[keys[i].substr(keys[i].length)] = 0
    }
    getUsersHashrates(function (newHashrates) {
      for (var address in newHashrates) {
        var AddressParts = address.split('+')
        hashrates[AddressParts[0]] = parseFloat(newHashrates[address]) + (hashrates[AddressParts[0]] || 0)
        hashrates[address] = newHashrates[address]
      }
      storeCollectedValues(chartName, hashrates, settings)
    })
  })
}

function getCoinPrice (callback) {
  apiInterfaces.jsonHttpRequest('api.cryptonator.com', 443, '', function (error, response) {
    callback(response.error ? response.error : error, response.success ? +response.ticker.price : null)
  }, '/api/ticker/' + global.config.symbol.toLowerCase() + '-usd')
}

function getCoinProfit (callback) {
  getCoinPrice(function (error, price) {
    if (error) {
      callback(error)
      return
    }
    getPoolStats(function (error, stats) {
      if (error) {
        callback(error)
        return
      }
      callback(null, stats.network.reward * price / stats.network.difficulty / global.config.coinUnits)
    })
  })
}

function getPoolChartsData (callback) {
  var chartsNames = []
  var redisKeys = []
  for (var chartName in global.config.charts.pool) {
    if (global.config.charts.pool[chartName].enabled) {
      chartsNames.push(chartName)
      redisKeys.push(getStatsRedisKey(chartName))
    }
  }
  if (redisKeys.length) {
    global.redisClient.mget(redisKeys, function (error, data) {
      var stats = {}
      if (data) {
        for (var i in data) {
          if (data[i]) {
            stats[chartsNames[i]] = JSON.parse(data[i])
          }
        }
      }
      callback(error, stats)
    })
  } else {
    callback(null, {})
  }
}

module.exports = {
  startDataCollectors: startDataCollectors,
  getUserChartsData: getUserChartsData,
  getPoolChartsData: getPoolChartsData,
  getUserWorkerChartsData: getUserWorkerChartsData
}
