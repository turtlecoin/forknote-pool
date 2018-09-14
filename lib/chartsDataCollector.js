var charts = require('./charts.js')

var logSystem = 'chartsDataCollector'
require('./exceptionWriter.js')(logSystem)

global.log('info', logSystem, 'Started')

charts.startDataCollectors()
