var fs = require('fs')

var async = require('async')

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api)

var logSystem = 'payments'
require('./exceptionWriter.js')(logSystem)

log('info', logSystem, 'Started')

function runInterval () {
  async.waterfall([

    // Get worker keys
    function (callback) {
      redisClient.keys(config.coin + ':workers:*', function (error, result) {
        if (error) {
          log('error', logSystem, 'Error trying to get worker balances from redis %j', [error])
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
      redisClient.multi(redisCommands).exec(function (error, replies) {
        if (error) {
          log('error', logSystem, 'Error with getting balances from redis %j', [error])
          callback(true)
          return
        }
        var balances = {}
        var minPayoutLevel = {}
        for (var i = 0; i < replies.length; i++) {
          var parts = keys[i].split(':')
          var workerId = parts[parts.length - 1]
          data = replies[i]
          balances[workerId] = parseInt(data[0]) || 0
          minPayoutLevel[workerId] = parseFloat(data[1]) || config.payments.minPayment
          log('info', logSystem, 'Using payout level %d for worker %s (default: %d)', [minPayoutLevel[workerId], workerId, config.payments.minPayment])
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
          var remainder = balance % config.payments.denomination
          var payout = balance - remainder
          if (payout < 0) continue
          payments[worker] = payout
        }
      }

      if (Object.keys(payments).length === 0) {
        log('info', logSystem, 'No workers\' balances reached the minimum payment threshold')
        callback(true)
        return
      }

      var transferCommands = []
      var addresses = 0
      var commandAmount = 0
      var commandIndex = 0

      for (var worker in payments) {
        var amount = parseInt(payments[worker])
        if (config.payments.maxTransactionAmount && amount + commandAmount > config.payments.maxTransactionAmount) {
		            amount = config.payments.maxTransactionAmount - commandAmount
	            }

        if (!transferCommands[commandIndex]) {
          transferCommands[commandIndex] = {
            redis: [],
            amount: 0,
            rpc: {
                        				transfers: [],
                        				fee: config.payments.transferFee,
            }
          }
        }

        transferCommands[commandIndex].rpc.transfers.push({amount: amount, address: worker})
        transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -amount])
        transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'paid', amount])
        transferCommands[commandIndex].amount += amount

        addresses++
        commandAmount += amount
        if (addresses >= config.payments.maxAddresses || (config.payments.maxTransactionAmount && commandAmount >= config.payments.maxTransactionAmount)) {
          commandIndex++
          addresses = 0
          commandAmount = 0
        }
      }

      var timeOffset = 0

      async.filter(transferCommands, function (transferCmd, cback) {
        apiInterfaces.rpcWallet('sendTransaction', transferCmd.rpc, function (error, result) {
          if (error) {
            log('error', logSystem, 'Error with sendTransaction RPC request to wallet daemon %j', [error])
            log('error', logSystem, 'Payments failed to send to %j', transferCmd.rpc.transfers)
            cback(false)
            return
          }

          var now = (timeOffset++) + Date.now() / 1000 | 0
          var txHash = result.transactionHash

          transferCmd.redis.push(['zadd', config.coin + ':payments:all', now, [
            txHash,
            transferCmd.amount,
            transferCmd.rpc.fee,
            Object.keys(transferCmd.rpc.transfers).length
          ].join(':')])

          for (var i = 0; i < transferCmd.rpc.transfers.length; i++) {
            var destination = transferCmd.rpc.transfers[i]
            transferCmd.redis.push(['zadd', config.coin + ':payments:' + destination.address, now, [
              txHash,
              destination.amount,
              transferCmd.rpc.fee,
            ].join(':')])
          }

          log('info', logSystem, 'Payments sent via wallet daemon %j', [result])
          redisClient.multi(transferCmd.redis).exec(function (error, replies) {
            if (error) {
              log('error', logSystem, 'Super critical error! Payments sent yet failing to update balance in redis, double payouts likely to happen %j', [error])
              log('error', logSystem, 'Double payments likely to be sent to %j', transferCmd.rpc.transfers)
              cback(false)
              return
            }
            cback(true)
          })
        })
      }, function (succeeded) {
        var failedAmount = transferCommands.length - succeeded.length
        log('info', logSystem, 'Payments splintered and %d successfully sent, %d failed', [succeeded.length, failedAmount])
        callback(null)
      })
    }

  ], function (error, result) {
    setTimeout(runInterval, config.payments.interval * 1000)
  })
}

runInterval()
