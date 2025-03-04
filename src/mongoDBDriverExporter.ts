import { Gauge, Histogram, type Registry } from 'prom-client'
import type { ConnectionCreatedEvent, ConnectionClosedEvent, ConnectionPoolCreatedEvent, ConnectionCheckOutStartedEvent, ConnectionCheckedOutEvent, ConnectionCheckOutFailedEvent, ConnectionCheckedInEvent, ConnectionPoolClosedEvent, CommandSucceededEvent, CommandFailedEvent, MongoClient } from 'mongodb'
import { type MongoDBDriverExporterOptions } from './exporter'

export class MongoDBDriverExporter {
  private readonly register: Registry
  private readonly mongoClient: MongoClient
  private readonly options: MongoDBDriverExporterOptions
  private readonly defaultOptions: MongoDBDriverExporterOptions = {
    mongodbDriverCommandsSecondsHistogramBuckets: [0.001, 0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10]
  }

  // pool metrics
  private readonly poolSize: Gauge
  private readonly minSize: Gauge
  private readonly maxSize: Gauge
  private readonly checkedOut: Gauge
  private readonly waitQueueSize: Gauge

  // command metrics
  private readonly commands: Histogram

  constructor (mongoClient: MongoClient, register: Registry, options?: MongoDBDriverExporterOptions) {
    if (mongoClient == null || mongoClient === undefined) {
      options?.logger?.error('mongoClient is null or undefined. No metrics can be exported.')
      throw new Error('mongoClient is null or undefined. No metrics can be exported.')
    }
    this.mongoClient = mongoClient

    if (register == null || mongoClient === undefined) {
      options?.logger?.error('register is null or undefined. No metrics can be exported.')
      throw new Error('register is null or undefined. No metrics can be exported.')
    }
    this.register = register
    this.options = { ...this.defaultOptions, ...options }

    this.poolSize = new Gauge({
      name: 'mongodb_driver_pool_size',
      help: 'the current size of the connection pool, including idle and in-use members',
      labelNames: this.mergeLabelNamesWithStandardLabels(['server_address']),
      registers: [this.register]
    })

    this.minSize = new Gauge({
      name: 'mongodb_driver_pool_min',
      help: 'the minimum size of the connection pool',
      labelNames: this.mergeLabelNamesWithStandardLabels(['server_address']),
      registers: [this.register]
    })

    this.maxSize = new Gauge({
      name: 'mongodb_driver_pool_max',
      help: 'the maximum size of the connection pool',
      labelNames: this.mergeLabelNamesWithStandardLabels(['server_address']),
      registers: [this.register]
    })

    this.checkedOut = new Gauge({
      name: 'mongodb_driver_pool_checkedout',
      help: 'the count of connections that are currently in use',
      labelNames: this.mergeLabelNamesWithStandardLabels(['server_address']),
      registers: [this.register]
    })

    this.waitQueueSize = new Gauge({
      name: 'mongodb_driver_pool_waitqueuesize',
      help: 'the current size of the wait queue for a connection from the pool',
      labelNames: this.mergeLabelNamesWithStandardLabels(['server_address']),
      registers: [this.register]
    })

    if (this.monitorCommands()) {
      this.commands = new Histogram({
        name: 'mongodb_driver_commands_seconds',
        help: 'Timer of mongodb commands',
        buckets: this.options.mongodbDriverCommandsSecondsHistogramBuckets,
        labelNames: this.mergeLabelNamesWithStandardLabels(['command', 'server_address', 'status']),
        registers: [this.register]
      })
    }
  }

  enableMetrics (): void {
    this.mongoClient.on('connectionPoolCreated', (event) => { this.onConnectionPoolCreated(event) })
    this.mongoClient.on('connectionPoolClosed', (event) => { this.onConnectionPoolClosed(event) })
    this.mongoClient.on('connectionCreated', (event) => { this.onConnectionCreated(event) })
    this.mongoClient.on('connectionClosed', (event) => { this.onConnectionClosed(event) })
    this.mongoClient.on('connectionCheckOutStarted', (event) => { this.onConnectionCheckOutStarted(event) })
    this.mongoClient.on('connectionCheckedOut', (event) => { this.onConnectionCheckedOut(event) })
    this.mongoClient.on('connectionCheckOutFailed', (event) => { this.onConnectionCheckOutFailed(event) })
    this.mongoClient.on('connectionCheckedIn', (event) => { this.onConnectionCheckedIn(event) })
    this.options?.logger?.info('Successfully enabled connection pool metrics for the MongoDB Node.js driver.')

    // command metrics
    if (this.monitorCommands()) {
      this.mongoClient.on('commandSucceeded', (event) => { this.onCommandSucceeded(event) })
      this.mongoClient.on('commandFailed', (event) => { this.onCommandFailed(event) })
      this.options?.logger?.info('Successfully enabled command metrics for the MongoDB Node.js driver.')
    }
  }

  private monitorCommands (): boolean {
    return this.mongoClient.options.monitorCommands.valueOf()
  }

  private mergeLabelNamesWithStandardLabels (labelNames: string[]): string[] {
    let merged: string[]
    this.options?.defaultLabels != null ? merged = labelNames.concat(Object.keys(this.options.defaultLabels)) : merged = labelNames
    return merged
  }

  private mergeLabelsWithStandardLabels (labels: Record<string, string | number>): Record<string, string | number> {
    let merged: Record<string, string | number>
    this.options?.defaultLabels != null ? merged = { ...labels, ...this.options?.defaultLabels } : merged = labels
    return merged
  }

  private onConnectionPoolCreated (event: ConnectionPoolCreatedEvent): void {
    this.poolSize.set(this.mergeLabelsWithStandardLabels({ server_address: event.address }), 0)
    this.minSize.set(this.mergeLabelsWithStandardLabels({ server_address: event.address }), event.options.minPoolSize)
    this.maxSize.set(this.mergeLabelsWithStandardLabels({ server_address: event.address }), event.options.maxPoolSize)
    this.checkedOut.set(this.mergeLabelsWithStandardLabels({ server_address: event.address }), 0)
    this.waitQueueSize.set(this.mergeLabelsWithStandardLabels({ server_address: event.address }), 0)
  }

  private onConnectionCreated (event: ConnectionCreatedEvent): void {
    this.poolSize.inc(this.mergeLabelsWithStandardLabels({ server_address: event.address }))
  }

  private onConnectionClosed (event: ConnectionClosedEvent): void {
    this.poolSize.dec(this.mergeLabelsWithStandardLabels({ server_address: event.address }))
  }

  private onConnectionCheckOutStarted (event: ConnectionCheckOutStartedEvent): void {
    this.waitQueueSize.inc(this.mergeLabelsWithStandardLabels({ server_address: event.address }))
  }

  private onConnectionCheckedOut (event: ConnectionCheckedOutEvent): void {
    this.checkedOut.inc(this.mergeLabelsWithStandardLabels({ server_address: event.address }))
    this.waitQueueSize.dec(this.mergeLabelsWithStandardLabels({ server_address: event.address }))
  }

  private onConnectionCheckOutFailed (event: ConnectionCheckOutFailedEvent): void {
    this.waitQueueSize.dec(this.mergeLabelsWithStandardLabels({ server_address: event.address }))
  }

  private onConnectionCheckedIn (event: ConnectionCheckedInEvent): void {
    this.checkedOut.dec(this.mergeLabelsWithStandardLabels({ server_address: event.address }))
  }

  private onConnectionPoolClosed (event: ConnectionPoolClosedEvent): void {
    this.poolSize.set(this.mergeLabelsWithStandardLabels({ server_address: event.address }), 0)
    this.minSize.reset()
    this.maxSize.reset()
    this.checkedOut.reset()
    this.waitQueueSize.reset()
  }

  private onCommandSucceeded (event: CommandSucceededEvent): void {
    this.commands.observe(this.mergeLabelsWithStandardLabels({ command: event.commandName, server_address: event.address, status: 'SUCCESS' }), event.duration / 1000)
  }

  private onCommandFailed (event: CommandFailedEvent): void {
    this.commands.observe(this.mergeLabelsWithStandardLabels({ command: event.commandName, server_address: event.address, status: 'FAILED' }), event.duration / 1000)
  }
}
