var path = require('path')
var url_ = require('url')
var bodyParser = require('body-parser')
var https = require('https')
var http = require('http')
var cors = require('cors')
var instanceRouter = require('../routes/routesInstance')
var configurationRouter = require('../routes/routesConfiguration')

var config = require('../config/config')
var express = require('express')
var Room = require('./Room')
var protooServer = require('protoo-server')

var mediasoup = require('mediasoup')

var fs = require('fs')
var socketIO = require('socket.io')
var EventEmitter = require('events')
var logger = require('./Logger')

class Server extends EventEmitter {
  constructor () {
    super()
    this.rooms = new Map()
    process.env.DEBUG = config.debug || '*LOG* *WARN* *DEBUG* *ERROR*'
  }

  setWebServer (webServer) {
    this.webServer = webServer
    return this
  }

  listen (options) {
    this.options = options
    this.mediaServer = mediasoup.Server({
      numWorkers: 1,
      logLevel: config.mediasoup.logLevel,
      logTags: config.mediasoup.logTags,
      rtcIPv4: config.mediasoup.rtcIPv4,
      rtcIPv6: config.mediasoup.rtcIPv6,
      rtcAnnouncedIPv4: config.mediasoup.rtcAnnouncedIPv4,
      rtcAnnouncedIPv6: config.mediasoup.rtcAnnouncedIPv6,
      rtcMinPort: config.mediasoup.rtcMinPort,
      rtcMaxPort: config.mediasoup.rtcMaxPort
    })
    global.SERVER = this.mediaServer
    this.mediaServer.on('newroom', (room) => {
      global.ROOM = room
    })

    if (!this.webServer) {
      this.startWebServer()
    }

    this.startSocketServer()

    setTimeout(() => {
      this.emit('listen')
    }, 0)

    return this
  }

  startWebServer () {
    const app = express()

    this.tls = {
      cert: fs.readFileSync(config.tls.cert),
      key: fs.readFileSync(config.tls.key)
    }
    app.use(bodyParser.json())
    app.use(cors())
    // TODO refactor this to handle
    app.use('/stream', express.static(path.join(__dirname, '/../stream')))
    app.use(instanceRouter)
    app.use(configurationRouter)

    if (app.get('env') === 'development') {
      app.use(function (err, req, res, next) {
        logger.log('error', "get's to error")
        logger.log('error', err)
        res.json(err)
        // TODO is this enough. This isn't working.
        // Here should i list every possible variations of the error.
        // List all errors as indicators for the system.
      })
    }

    app.use(function (err, req, res, next) {
      res.json(err)
      logger.log('error', 'production ' + err.message)
    })
    app.set('appName', 'rest_for_head')

    // server.listen(app.get('port'), function () 
    this.server_ = http.createServer(app)
    this.server = https.createServer(this.tls, app => {
      // TODO message for not here.
    })
    // TODO where should this funciton be.
    this.server.listen(config.protoo.listenPort, config.protoo.listenIp, function () {
      logger.log('info', 'Express server is listening on port ' + config.protoo.listenPort)
    })
    // TODO http requests.
    this.server_.listen(config.http.listenPort)
    logger.log('info', 'listening http on port: ' + config.http.listenPort)
  }

  startSocketServer () {
    this.io = socketIO(this.webServer)

    let webSocketServer = new protooServer.WebSocketServer(this.server, {
      maxReceivedFrameSize: 960000,
      maxReceivedMessageSize: 960000,
      fragmentOutgoingMessage: true,
      fragmentationThreshold: 960000
    })

    webSocketServer.on('connectionrequest', (info, accept, reject) => {
      let u = url_.parse(info.request.url, true)
      let roomId = u.query['room-id']
      let peerId = u.query['peer-id']

      if (!roomId || !peerId) {
        reject(400, 'Connection request without roomId and/or peerId')
        return
      }

      if (!this.rooms.has(roomId)) {
        let room = new Room(roomId, this.mediaServer)
        let logStatusTimer = setInterval(() => {
          room.logStatus()
        }, 10000)

        this.rooms.set(roomId, room)
        this.emit('new-connection', room)
        room.on('close', () => {
          this.rooms.delete(roomId)
          clearInterval(logStatusTimer)
        })
      }

      let room = this.rooms.get(roomId)
      let transport = accept()

      room.createProtooPeer(peerId, transport)
        .catch((error) => {
          logger.log('error', 'error creating a protoo peer: %s', error)
        })
    })
    // TODO do functional parameters.
  }
}

module.exports = Server
