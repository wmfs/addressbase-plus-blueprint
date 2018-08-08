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
  const OUTPUT_AND_INPUT_DIR = path.resolve(__dirname, './output')
  const UPSERTS_DIR = path.resolve(OUTPUT_AND_INPUT_DIR, './upserts')
  const MANIFEST_FILE = path.resolve(OUTPUT_AND_INPUT_DIR, './manifest.json')

  let tymlyService
  let statebox
  let client

  before(function () {
    if (process.env.PG_CONNECTION_STRING && !/^postgres:\/\/[^:]+:[^@]+@(?:localhost|127\.0\.0\.1).*$/.test(process.env.PG_CONNECTION_STRING)) {
      console.log(`Skipping tests due to unsafe PG_CONNECTION_STRING value (${process.env.PG_CONNECTION_STRING})`)
      this.skip()
    }

    if (fs.existsSync(OUTPUT_AND_INPUT_DIR)) {
      rimraf.sync(OUTPUT_AND_INPUT_DIR, {}, done)
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
            path.resolve(__dirname, './..')
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
          outputDirRootPath: OUTPUT_AND_INPUT_DIR,
          sourceDir: OUTPUT_AND_INPUT_DIR
        },
        'ordnanceSurvey_importCsvFiles_1_0',
        {
          sendResponse: 'COMPLETE'
        }
      )

      expect(executionDescription.status).to.eql('SUCCEEDED')
      expect(executionDescription.currentStateName).to.eql('ImportingCsvFiles')
      expect(executionDescription.ctx.sourceFilePaths).to.eql(LIST_OF_CSV_SOURCE_FILES)
      expect(executionDescription.ctx.outputDirRootPath).to.eql(OUTPUT_AND_INPUT_DIR)
      expect(executionDescription.ctx.sourceDir).to.eql(OUTPUT_AND_INPUT_DIR)
    })

    it('check line count in the manifest file ', () => {
      const data = fs.readFileSync(MANIFEST_FILE, 'utf8')

      const manifest = JSON.parse(data)
      // console.log(JSON.stringify(manifest, null, 2))
      expect(manifest.counts.byDir.upserts).to.eql(20)
    })

    it('verify addressbase-holding.csv file', () => {
      const CSV_FILE = path.resolve(UPSERTS_DIR, './addressbase-holding.csv')
      fs.statSync(CSV_FILE)
    })

    it('verify table is populated', async () => {
      const result = await client.query('SELECT uprn, hash_sum FROM ordnance_survey.addressbase_holding ORDER BY uprn ASC;')

      expect(result.rowCount).to.eql(20)
      expect(result.rows[8].uprn).to.eql('100040214823')
    })
  })

  describe('clean up', () => {
    it('shutdown Tymly', () => {
      return tymlyService.shutdown()
    })
  })
})
