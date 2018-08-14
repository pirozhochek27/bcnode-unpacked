/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Logger } from 'winston'
import type { $Request, $Response, NextFunction } from 'express'

const debug = require('debug')('bcnode:server:main')
const path = require('path')
const http = require('http')
const bodyParser = require('body-parser')
const express = require('express')
const expressWinston = require('express-winston')
const responseTime = require('response-time')
const serveIndex = require('serve-index')
const WebSocket = require('ws')
const CircularBuffer = require('circular-buffer')
const SocketIO = require('socket.io')

const { anyDns } = require('../engine/helper')
const logging = require('../logger')
const { config } = require('../config')
const { Null, Block } = require('../protos/core_pb')
const { Engine } = require('../engine')
const { RpcClient, RpcServer } = require('../rpc')
const { dispatcher: socketDispatcher } = require('./socket')

const assetsDir = path.resolve(__dirname, '..', '..', 'public')
const docsDir = path.resolve(__dirname, '..', '..', 'docs')
const logsDir = path.resolve(__dirname, '..', '..', '_logs')

const PORT = (process.env.BC_UI_PORT && parseInt(process.env.BC_UI_PORT, 10)) || config.server.port

type Opts = {|
  ws: bool,
  rpc: bool,
  ui: bool
|}

// See http://www.programwitherik.com/getting-started-with-socket-io-node-js-and-express/
export class Server {
  _opts: Opts
  _app: express$Application // eslint-disable-line
  _engine: Engine
  _rpcClient: RpcClient
  _rpcServer: RpcServer
  _server: any
  _logger: Logger
  _roveredBlocksBuffer: CircularBuffer
  _socket: ?SocketIO

  constructor (engine: Engine, rpcServer: RpcServer) {
    // Create express app instance
    this._app = express()
    this._engine = engine
    this._rpcClient = new RpcClient()
    this._rpcServer = rpcServer
    this._server = null
    this._logger = logging.getLogger(__filename)
    this._roveredBlocksBuffer = new CircularBuffer(24)

    // setInterval(() => {
    //   const peers = this._getPeers()
    //   this._logger.info('!!! PEERS', peers)
    // }, 3000)
  }

  get app (): express$Application { // eslint-disable-line
    return this._app
  }

  get engine (): Engine {
    return this._engine
  }

  get opts (): Opts {
    return this._opts
  }

  get rpcClient (): RpcClient {
    return this._rpcClient
  }

  get server (): any {
    return this._server
  }

  run (opts: Opts): Promise<bool> {
    this._opts = opts

    anyDns().then((ip) => {
      this._ip = ip
    })

    this._logger.debug('Starting Server for Web UI')

    if (config.server.logCalls) {
      this._app.use(expressWinston.logger({ winstonInstance: this._logger }))
    }
    this._app.use(responseTime())
    this._app.use(bodyParser.json())

    // TODO: Generate automagically
    const mapping = {
      getLatestBlocks: Null,
      help: Null
    }

    // console.log(this._engine.node.p2p)
    // this._logger.info('!!! SERVER START', this._engine._node)

    this._app.get('/geo/ip2geo/:ip', (req, res, next) => {
      const ip = req.params.ip
      const geores = this.engine.geoDb.get(ip)
      const city = geores && geores.city
      const location = geores && geores.location

      res.json({
        ip: ip,
        city,
        location
      })
    })

    this._app.get('/balance/:address', (req, res: $Response, next: NextFunction) => {
      const address = req.params.address
      if (address) {
        this._engine.persistence.getBtAddressBalance(req.params.address)
          .then((result) => {
            result.address = address
            res.json(result)
          })
      } else {
        res.json({})
      }
    })

    this._app.get('/balance', (req, res: $Response, next: NextFunction) => {
      const address = this.engine.minerKey
      if (address) {
        this._engine.persistence.getBtAddressBalance(address)
          .then((result) => {
            result.address = address
            res.json(result)
          })
      } else {
        res.json({})
      }
    })

    this._app.use('/rpc', jsonRpcMiddleware(mapping))

    // Create http server
    // $FlowFixMe see https://github.com/facebook/flow/issues/5113
    const server = (this._server = http.Server(this.app))

    if (this.opts.ws) {
      this.initWebSocket(server)
    }

    if (this.opts.rpc) {
      this.initRpc()
    }

    if (this.opts.ui) {
      this.initUi()
    }

    // Listen for connections
    server.listen(PORT, () => {
      this._logger.info(`Server available at http://0.0.0.0:${PORT}`)
    })

    return Promise.resolve(true)
  }

  initWebSocket (server) {
    const serverSocket = SocketIO(server, {
      path: '/ws',
      transports: [
        'websocket',
        'polling'
      ]
    })

    serverSocket.on('connection', (socket) => {
      const ip = socket.request.connection.remoteAddress

      debug('socket client connected', socket.id, ip)

      const peerInterval = setInterval(() => {
        const peers = this._getPeers()
        this._wsBroadcast({
          type: 'map.peers',
          data: peers
        })
      }, 10000)

      socket.on('disconnect', () => {
        debug('socket client disconnected', socket.id, ip)

        clearInterval(peerInterval)
      })

      socket.on('message', (msg) => {
        debug('socket message received', msg)
      })

      socket.on('block.get', (msg) => {
        socketDispatcher(this, socket, { type: 'block.get', data: msg })
      })

      socket.on('blocks.get', (msg) => {
        socketDispatcher(this, socket, { type: 'blocks.get', data: msg })
      })

      socket.on('multiverse.get', (msg) => {
        socketDispatcher(this, socket, { type: 'multiverse.get', data: msg })
      })

      socket.on('multiverse.purge', (msg) => {
        socketDispatcher(this, socket, { type: 'multiverse.purge', data: msg })
      })

      this._wsSendInitialState(socket)
    })

    // setup relaying events from rpc server to websockets
    this._rpcServer.emitter.on('collectBlock', ({ block }) => {
      this._roveredBlocksBuffer.enq(block)
      this._wsBroadcast({ type: 'block.latest', data: this._transformBlockToWire(block) })
    })

    this._socket = serverSocket
  }

  initRpc () {
    this.app.post('/rpc', (req, res: $Response, next: NextFunction) => {
      // console.log('/rpc, req: ', req.body)

      const { method } = req.rpcBody

      // Handle error state as described - http://www.jsonrpc.org/specification#error_object
      if (!this.rpcClient.bc[method]) {
        return res.json({
          code: -32601,
          message: 'Method not found'
        })
      }

      const { MsgType, params, id } = req.rpcBody
      const msg = new MsgType(params)

      this.rpcClient.bc[method](msg, (err, response) => {
        if (err) {
          this._logger.error(err)

          return res.json({
            error: err
          })
        }

        res.json({
          jsonrpc: '2.0',
          result: response.toObject(),
          id
        })
      })
    })
  }

  initUi () {
    this.app.use('/doc', express.static(docsDir))
    this.app.use('/logs',
      express.static(logsDir),
      serveIndex(logsDir, {
        icons: true,
        view: 'details'
      })
    )

    // Serve static content
    this.app.use(
      express.static(assetsDir),
      serveIndex(assetsDir, {
        icons: true
      })
    )

    // Subscribe for events
    this.engine.pubsub.subscribe('block.mined', '<server>', (block: Object) => {
      this._wsBroadcast(block)
    })
  }

  _getP2P (): Object {
    return this._engine._p2p || this._engine._node._p2p
  }

  _getPeers (): Object {
    const p2p = this._getP2P()
    if (!p2p) {
      return {}
    }

    const ip = this._ip || p2p.ip
    if (!ip) {
      return {}
    }

    const geo = this._engine.geoDb.get(ip)
    const me = {
      ip,
      city: geo.city,
      location: geo.location
    }

    const connections = p2p.connections || []
    const peers = connections.reduce((acc, val) => {
      const ip = `${val.remoteAddress}`
      const geo = this._engine.geoDb.get(ip)
      if (geo.location) {
        acc[ip] = {
          ip: ip,
          city: geo.city,
          location: geo.location
        }
      }
      return acc
    }, {})

    return {
      me,
      peers
    }
  }

  _transformBlockToWire (block: Block) {
    if (block !== undefined && block.getTimestamp !== undefined) {
      return {
        timestamp: block.getTimestamp(),
        blockchain: block.getBlockchain(),
        hash: block.getHash()
      }
    } else {
      return {}
    }
  }

  _transformPeerToWire (peer: Object) {
    /* eslint-disable */
    // return {
    //  id: ""peer.id.toB58String(),
    //  meta: peer.meta,
    //  addrs: peer.multiaddrs._multiaddrs.map((addr) => addr.toString()),
    //  addr: peer._connectedMultiaddr && peer._connectedMultiaddr.toString()
    // }
    return {
      id: '',
      meta: '',
      addrs: '',
      addr: ''
    }
  }

  _transformNewPeerToWire (peer: Object) {
    // console.log('peer', peer)
    return {
      id: peer.id.toB58String(),
      meta: peer.meta,
      addrs: peer.multiaddrs._multiaddrs.map((addr) => addr.toString()),
      addr: peer._connectedMultiaddr && peer._connectedMultiaddr.toString()
    }
  }

  _wsBroadcast (msg: Object) {
    if (this._socket) {
      this._socket.emit(msg.type, msg.data)
    }
  }

  _wsBroadcastMultiverse (multiverse: Object) {
    const blocksToSend = multiverse._chain

    this._wsBroadcast({
      type: 'multiverse.set',
      data: blocksToSend
    })
  }

  _wsBroadcastPeerConnected (peer: Object) {
    this._wsBroadcast({
      type: 'peer.connected',
      data: this._transformPeerToWire(peer)
    })
  }

  _wsBroadcastPeerDisonnected (peer: Object) {
    this._wsBroadcast({
      type: 'peer.disconnected',
      data: this._transformPeerToWire(peer)
    })
  }

  _wsBroadcastPeerCount (count: Number) {
    this._wsBroadcast({
      type: 'peer.count',
      data: count
    })
  }

  _wsSendInitialState (socket: WebSocket.Client) {
    let peers = []

    const node = this._engine._node
    const peerBook = node && node.manager.peerBookConnected
    if (peerBook) {
      peers = peerBook.getAllArray().map((peer) => {
        return this._transformPeerToWire(peer)
      })
    }

    let peer = null
    if (node && node.peer) {
      peer = this._transformPeerToWire(node.peer)
    }

    const msgs = [
      {
        type: 'block.snapshot',
        data: this._roveredBlocksBuffer.toarray().map(this._transformBlockToWire)
      },
      {
        type: 'peer.snapshot',
        data: peers
      },
      {
        type: 'profile.set',
        data: {
          peer
        }
      },
      {
        type: 'map.peers',
        data: this._getPeers()
      }
    ]

    msgs.forEach((msg) => {
      socket.emit(msg.type, msg.data)
    })
  }
}

/**
 * Converts incoming json body to rpc body using mapping provided
 *
 *  Mapping
 *
 *  ```
 *  {
 *    subtract: Object
 *  }
 *  ```
 *
 * Incoming JSON body
 *
 * ```
 * {
 *   jsonrpc: '2.0',
 *   method: 'subtract',
 *   params: [ 42, 23 ],
 *   id: 1
 * }
 * ```
 *
 * Fabricated (output) RPC message
 *
 * ```
 * {
 *   method: 'subtract',
 *   params: [42, 23],
 *   MsgType: Object
 * }
 * ```
 *
 * @param mappings
 * @return {Function}
 */
// TODO: Order named params to params array
// TODO: Handle RPC call batch
export function jsonRpcMiddleware (mappings: any) {
  // TODO: Report why is the request invalid
  function validRequest (rpc) {
    // $FlowFixMe
    return rpc.jsonrpc === '2.0' &&
      // $FlowFixMe
      (typeof rpc.id === 'number' || typeof rpc.id === 'string') &&
      // $FlowFixMe
      typeof rpc.method === 'string'
  }

  return function (req: $Request, res: $Response, next: NextFunction) {
    if (!validRequest(req.body)) {
      res.json({
        code: -32600,
        message: 'Invalid Request'
      })

      return
    }

    // $FlowFixMe
    const { method, params } = req.body
    // $FlowFixMe
    req.rpcBody = {
      method,
      params, // Handle named params
      // $FlowFixMe
      MsgType: mappings[req.body.method],
      // $FlowFixMe
      id: req.body.id
    }

    next()
  }
}

export default Server
