/* eslint-env mocha */

'use strict'

const expect = require('chai').expect
const tymly = require('@wmfs/tymly')
const path = require('path')
const fs = require('fs')
const rimraf = require('rimraf')
const process = require('process')

describe('Addressbase Plus Tests', function () {
  this.timeout(process.env.TIMEOUT || 5000)

  const LIST_OF_CSV_SOURCE_FILES = [
    path.resolve(__dirname, './fixtures/sample-data/exeter-sample-data-20.csv')
  ]
  const outputDir = path.resolve(__dirname, './output')
  const upsertsDir = path.resolve(outputDir, './upserts')
  const MANIFEST_FILE = path.resolve(outputDir, './manifest.json')

  const syncOutputDir = path.resolve(outputDir, 'sync')

  let tymlyService
  let statebox
  let client

  before(function () {
    if (process.env.PG_CONNECTION_STRING && !/^postgres:\/\/[^:]+:[^@]+@(?:localhost|127\.0\.0\.1).*$/.test(process.env.PG_CONNECTION_STRING)) {
      console.log(`Skipping tests due to unsafe PG_CONNECTION_STRING value (${process.env.PG_CONNECTION_STRING})`)
      this.skip()
    }

    if (fs.existsSync(outputDir)) {
      rimraf.sync(outputDir, {})
    }
  })

  describe('start up', () => {
    it('start Tymly', function (done) {
      tymly.boot(
        {
          pluginPaths: [
            require.resolve('@wmfs/tymly-etl-plugin'),
            require.resolve('@wmfs/tymly-pg-plugin'),
            require.resolve('@wmfs/tymly-test-helpers/plugins/allow-everything-rbac-plugin')
          ],

          blueprintPaths: [
            path.resolve(__dirname, './..'),
            require.resolve('@wmfs/gazetteer-blueprint')
          ]
        },
        function (err, tymlyServices) {
          if (err) {
            done(err)
          }
          tymlyService = tymlyServices.tymly
          statebox = tymlyServices.statebox
          client = tymlyServices.storage.client
          done()
        }
      )
    })
  })

  describe('import csv', () => {
    it('execute the state-machine', async () => {
      const executionDescription = await statebox.startExecution(
        {
          sourceFilePaths: LIST_OF_CSV_SOURCE_FILES,
          outputDirRootPath: outputDir,
          sourceDir: outputDir
        },
        'ordnanceSurvey_importCsvFiles_1_0',
        {
          sendResponse: 'COMPLETE'
        }
      )

      expect(executionDescription.status).to.eql('SUCCEEDED')
      expect(executionDescription.currentStateName).to.eql('ImportingCsvFiles')
      expect(executionDescription.ctx.sourceFilePaths).to.eql(LIST_OF_CSV_SOURCE_FILES)
      expect(executionDescription.ctx.outputDirRootPath).to.eql(outputDir)
      expect(executionDescription.ctx.sourceDir).to.eql(outputDir)
    })

    it('check line count in the manifest file ', () => {
      const data = fs.readFileSync(MANIFEST_FILE, 'utf8')

      const manifest = JSON.parse(data)
      // console.log(JSON.stringify(manifest, null, 2))
      expect(manifest.counts.byDir.upserts).to.eql(20)
    })

    it('verify addressbase-holding.csv file', () => {
      const CSV_FILE = path.resolve(upsertsDir, './addressbase-holding.csv')
      fs.statSync(CSV_FILE)
    })

    it('verify table is populated', async () => {
      const result = await client.query('SELECT uprn, hash_sum FROM ordnance_survey.addressbase_holding ORDER BY uprn ASC;')

      expect(result.rowCount).to.eql(20)
      expect(result.rows[8].uprn).to.eql('100040214823')
    })
  })

  describe('synchronization', () => {
    it('populate test data', async () => {
      const sqlFile = path.resolve(__dirname, './fixtures/scripts/wmfs-gazetteer-setup.sql')
      await client.runFile(sqlFile)
    })

    it('check for a single gazetteer record', async () => {
      const result = await client.query('SELECT count(uprn) FROM wmfs.gazetteer')
      const count = result.rows[0].count
      expect(count).to.eql('1')
    })

    let existing
    it('grab existing row', async () => {
      const result = await client.query('SELECT * from wmfs.gazetteer')
      expect(result.rowCount).to.eql(1)

      existing = result.rows[0]
    })

    it('run synchronize-addressbox-premium state machine', async () => {
      const executionDescription = await statebox.startExecution(
        {
          outputDir: syncOutputDir
        }, // input
        'ordnanceSurvey_synchronizeAddressbasePlus_1_0', // state machine name
        {
          sendResponse: 'COMPLETE'
        }
      )

      expect(executionDescription.status).to.eql('SUCCEEDED')
      expect(executionDescription.currentStateName).to.eql('SynchronizingTable')
      expect(executionDescription.ctx.outputDir).to.eql(syncOutputDir)
    })

    it('check the newly populated gazetteer table', async () => {
      const result = await client.query('SELECT uprn FROM wmfs.gazetteer ORDER BY uprn ASC;', [])
      expect(result.rowCount).to.eql(21)
    })

    it('pre-existing row is unchanged', async () => {
      const result = await client.query(`SELECT * from wmfs.gazetteer WHERE uprn = ${existing.uprn}`)
      expect(result.rowCount).to.eql(1)

      expect(result.rows[0]).to.eql(existing)
    })
  })

  describe('clean up', () => {
    it('clear down database', async () => {
      await client.query('DROP SCHEMA ordnance_survey CASCADE')
      await client.query('DROP SCHEMA wmfs CASCADE')
    })

    it('shutdown Tymly', () => {
      return tymlyService.shutdown()
    })
  })
})
