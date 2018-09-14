var async = require('async')

var apiInterfaces = require('./apiInterfaces.js')(global.config.daemon, global.config.wallet, global.config.api)

var logSystem = 'payments'
require('./exceptionWriter.js')(logSystem)

global.log('info', logSystem, 'Started')

function runInterval () {
  async.waterfall([

    // Get worker keys
    function (callback) {
      global.redisClient.keys(global.config.coin + ':workers:*', function (error, result) {
        if (error) {
          global.log('error', logSystem, 'Error trying to get worker balances from redis %j', [error])
          callback(true)
          return
        }
        callback(null, result)
      })
    },

    // Get worker balances
    function (keys, callback) {
      var redisCommands = keys.map(function (k) {
        return ['hmget', k, 'balance', 'minPayoutLevel']
      })
      global.redisClient.multi(redisCommands).exec(function (error, replies) {
        if (error) {
          global.log('error', logSystem, 'Error with getting balances from redis %j', [error])
          callback(true)
          return
        }
        var balances = {}
        var minPayoutLevel = {}
        for (var i = 0; i < replies.length; i++) {
          var parts = keys[i].split(':')
          var workerId = parts[parts.length - 1]
          var data = replies[i]
          balances[workerId] = parseInt(data[0]) || 0
          minPayoutLevel[workerId] = parseFloat(data[1]) || global.config.payments.minPayment
          global.log('info', logSystem, 'Using payout level %d for worker %s (default: %d)', [minPayoutLevel[workerId], workerId, global.config.payments.minPayment])
        }
        callback(null, balances, minPayoutLevel)
      })
    },

    // Filter workers under balance threshold for payment
    function (balances, minPayoutLevel, callback) {
      var payments = {}

      for (var worker in balances) {
        var balance = balances[worker]
        if (balance >= minPayoutLevel[worker]) {
          var remainder = balance % global.config.payments.denomination
          var payout = balance - remainder
          if (payout < 0) continue
          payments[worker] = payout
        }
      }

      if (Object.keys(payments).length === 0) {
        global.log('info', logSystem, 'No workers\' balances reached the minimum payment threshold')
        callback(true)
        return
      }

      var transferCommands = []
      var addresses = 0
      var commandAmount = 0
      var commandIndex = 0

      for (worker in payments) {
        var amount = parseInt(payments[worker])
        if (global.config.payments.maxTransactionAmount && amount + commandAmount > global.config.payments.maxTransactionAmount) {
          amount = global.config.payments.maxTransactionAmount - commandAmount
        }

        if (!transferCommands[commandIndex]) {
          transferCommands[commandIndex] = {
            redis: [],
            amount: 0,
            rpc: {
              transfers: [],
              fee: global.config.payments.transferFee
            }
          }
        }

        transferCommands[commandIndex].rpc.transfers.push({amount: amount, address: worker})
        transferCommands[commandIndex].redis.push(['hincrby', global.config.coin + ':workers:' + worker, 'balance', -amount])
        transferCommands[commandIndex].redis.push(['hincrby', global.config.coin + ':workers:' + worker, 'paid', amount])
        transferCommands[commandIndex].amount += amount

        addresses++
        commandAmount += amount
        if (addresses >= global.config.payments.maxAddresses || (global.config.payments.maxTransactionAmount && commandAmount >= global.config.payments.maxTransactionAmount)) {
          commandIndex++
          addresses = 0
          commandAmount = 0
        }
      }

      var timeOffset = 0

      async.filter(transferCommands, function (transferCmd, cback) {
        apiInterfaces.rpcWallet('sendTransaction', transferCmd.rpc, function (error, result) {
          if (error) {
            global.log('error', logSystem, 'Error with sendTransaction RPC request to wallet daemon %j', [error])
            global.log('error', logSystem, 'Payments failed to send to %j', transferCmd.rpc.transfers)
            cback(false)
            return
          }

          var now = (timeOffset++) + Date.now() / 1000 | 0
          var txHash = result.transactionHash

          transferCmd.redis.push(['zadd', global.config.coin + ':payments:all', now, [
            txHash,
            transferCmd.amount,
            transferCmd.rpc.fee,
            Object.keys(transferCmd.rpc.transfers).length
          ].join(':')])

          for (var i = 0; i < transferCmd.rpc.transfers.length; i++) {
            var destination = transferCmd.rpc.transfers[i]
            transferCmd.redis.push(['zadd', global.config.coin + ':payments:' + destination.address, now, [
              txHash,
              destination.amount,
              transferCmd.rpc.fee
            ].join(':')])
          }

          global.log('info', logSystem, 'Payments sent via wallet daemon %j', [result])
          global.redisClient.multi(transferCmd.redis).exec(function (error, replies) {
            if (error) {
              global.log('error', logSystem, 'Super critical error! Payments sent yet failing to update balance in redis, double payouts likely to happen %j', [error])
              global.log('error', logSystem, 'Double payments likely to be sent to %j', transferCmd.rpc.transfers)
              cback(false)
              return
            }
            cback(true)
          })
        })
      }, function (succeeded) {
        var failedAmount = transferCommands.length - succeeded.length
        global.log('info', logSystem, 'Payments splintered and %d successfully sent, %d failed', [succeeded.length, failedAmount])
        callback(null)
      })
    }

  ], function (error, result) {
    global.log('info', logSystem, 'Payments processing failed: %s', [error])
    setTimeout(runInterval, global.config.payments.interval * 1000)
  })
}

runInterval()
