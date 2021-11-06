const {
  BaseKonnector,
  requestFactory,
  scrape,
  log,
  utils,
  saveFiles
} = require('cozy-konnector-libs')
const request = requestFactory({
  // Debug mode
  // debug: true,
  // Enable [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // Disable JSON parsing
  json: false,
  // Keep cookies between requests
  jar: true
})
const omit = require('lodash/omit')
const PassThrough = require('stream').PassThrough
const pdfjs = require('pdfjs-dist/es5/build/pdf.js')
const bluebird = require('bluebird')

const VENDOR = 'liveli'
const baseUrl = 'https://parents.liveli.fr'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
// cozyParameters are static parameters, independents from the account. Most often, it can be a
// secret api key.
async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  const landingPage = await authenticate.bind(this)(
    fields.login,
    fields.password
  )
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of documents')
  const $ = await request(landingPage(`ul[class='compte']>li>a`).attr('href'))

  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($)

  log('info', 'Saving data to Cozy')
  await this.saveBills(documents, fields, {
    // This is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['creches'],
    contentType: 'application/pdf'
  })
}

// Authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
function authenticate(username, password) {
  return this.signin({
    url: `${baseUrl}/site/pages/identificationPage.aspx`,
    formSelector: '#formConnexion',
    formData: {
      'FrontOfficeUser.Mail': username,
      'FrontOfficeUser.Password': password
    },
    validate: (statusCode, $) => {
      // Successful login when a log-out link is available
      if ($(`a[class='b_deco']`).length === 1) {
        return true
      } else {
        log('error', $('.error').text())
        return false
      }
    }
  })
}

// Extract the bill amount and vendor reference from the PDF file
async function getAmountAndRefInPdf(pdfBuffer) {
  const doc = await pdfjs.getDocument(new Uint8Array(pdfBuffer)).promise
  const page = await doc.getPage(1)
  const text = await page.getTextContent()
  const fullText = text.items
    .map(function(s) {
      return s.str
    })
    .join('\n')
  let vendorRef = null
  let amount = null

  const refMatch = fullText.match('N° PIECE\n(.*)\n')
  if (refMatch === null) {
    log('warn', 'No reference found in bill')
  } else {
    vendorRef = refMatch[1]
    log('debug', `Bill reference: ${vendorRef}`)
  }

  const amountMatch = fullText.match('(.*)\nEUROS\nTOTAL TTC\nNET A PAYER\n')
  if (amountMatch === null) {
    log('warn', 'No amount found in bill')
  } else {
    amount = parseFloat(amountMatch[1])
    log('debug', `Bill amount: ${amount}`)
  }

  return { vendorRef, amount }
}

// The goal of this function is to parse a HTML page wrapped by a cheerio instance
// and return an array of JS objects which will be saved to the cozy by saveBills
// (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
async function parseDocuments($) {
  // You can find documentation about the scrape function here:
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  let docs = scrape(
    $,
    {
      title: {
        sel: '.ctn_intitule'
      },
      date: {
        sel: '.ctn_date',
        parse: normalizeDate
      },
      fileUrl: {
        sel: '.btn_download',
        attr: 'href'
      }
    },
    '.ctn_factures>.obj_facture'
  )

  docs = await bluebird.mapSeries(docs, async doc => {
    if (doc.fileUrl) {
      const rq = requestFactory({
        cheerio: false,
        json: false,
        jar: true
      })
      const pdfBuffer = await rq({
        url: doc.fileUrl,
        encoding: null
      })
      const bufferStream = new PassThrough()
      bufferStream.end(pdfBuffer)

      const parsed = await getAmountAndRefInPdf(pdfBuffer)
      if (parsed.amount && parsed.vendorRef) {
        const filename = `${utils.formatDate(
          doc.date
        )}_${VENDOR}_${parsed.amount.toFixed(2)}EUR_${parsed.vendorRef}.pdf`

        return {
          ...doc,
          filename,
          filestream: bufferStream,
          amount: parsed.amount,
          currency: 'EUR',
          vendor: VENDOR
        }
      }
    }
  })

  return docs.map(x => omit(x, ['fileUrl']))
}

// Convert a date string to a date
function normalizeDate(date) {
  // String format: dd/mm/yyyy
  return new Date(
    date.slice(6, 10) + '-' + date.slice(3, 5) + '-' + date.slice(0, 2) + 'Z'
  )
}
