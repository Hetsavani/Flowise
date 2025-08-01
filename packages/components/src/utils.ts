import axios from 'axios'
import { load } from 'cheerio'
import * as fs from 'fs'
import * as path from 'path'
import { JSDOM } from 'jsdom'
import { z } from 'zod'
import TurndownService from 'turndown'
import { DataSource, Equal } from 'typeorm'
import { ICommonObject, IDatabaseEntity, IFileUpload, IMessage, INodeData, IVariable, MessageContentImageUrl } from './Interface'
import { AES, enc } from 'crypto-js'
import { omit } from 'lodash'
import { AIMessage, HumanMessage, BaseMessage } from '@langchain/core/messages'
import { Document } from '@langchain/core/documents'
import { getFileFromStorage } from './storageUtils'
import { GetSecretValueCommand, SecretsManagerClient, SecretsManagerClientConfig } from '@aws-sdk/client-secrets-manager'
import { customGet } from '../nodes/sequentialagents/commonUtils'
import { TextSplitter } from 'langchain/text_splitter'
import { DocumentLoader } from 'langchain/document_loaders/base'
import { NodeVM } from '@flowiseai/nodevm'
import { Sandbox } from '@e2b/code-interpreter'

export const numberOrExpressionRegex = '^(\\d+\\.?\\d*|{{.*}})$' //return true if string consists only numbers OR expression {{}}
export const notEmptyRegex = '(.|\\s)*\\S(.|\\s)*' //return true if string is not empty or blank
export const FLOWISE_CHATID = 'flowise_chatId'

let secretsManagerClient: SecretsManagerClient | null = null
const USE_AWS_SECRETS_MANAGER = process.env.SECRETKEY_STORAGE_TYPE === 'aws'
if (USE_AWS_SECRETS_MANAGER) {
    const region = process.env.SECRETKEY_AWS_REGION || 'us-east-1' // Default region if not provided
    const accessKeyId = process.env.SECRETKEY_AWS_ACCESS_KEY
    const secretAccessKey = process.env.SECRETKEY_AWS_SECRET_KEY

    const secretManagerConfig: SecretsManagerClientConfig = {
        region: region
    }

    if (accessKeyId && secretAccessKey) {
        secretManagerConfig.credentials = {
            accessKeyId,
            secretAccessKey
        }
    }

    secretsManagerClient = new SecretsManagerClient(secretManagerConfig)
}

/*
 * List of dependencies allowed to be import in @flowiseai/nodevm
 */
export const availableDependencies = [
    '@aws-sdk/client-bedrock-runtime',
    '@aws-sdk/client-dynamodb',
    '@aws-sdk/client-s3',
    '@elastic/elasticsearch',
    '@dqbd/tiktoken',
    '@getzep/zep-js',
    '@gomomento/sdk',
    '@gomomento/sdk-core',
    '@google-ai/generativelanguage',
    '@google/generative-ai',
    '@huggingface/inference',
    '@langchain/anthropic',
    '@langchain/aws',
    '@langchain/cohere',
    '@langchain/community',
    '@langchain/core',
    '@langchain/google-genai',
    '@langchain/google-vertexai',
    '@langchain/groq',
    '@langchain/langgraph',
    '@langchain/mistralai',
    '@langchain/mongodb',
    '@langchain/ollama',
    '@langchain/openai',
    '@langchain/pinecone',
    '@langchain/qdrant',
    '@langchain/weaviate',
    '@notionhq/client',
    '@opensearch-project/opensearch',
    '@pinecone-database/pinecone',
    '@qdrant/js-client-rest',
    '@supabase/supabase-js',
    '@upstash/redis',
    '@zilliz/milvus2-sdk-node',
    'apify-client',
    'axios',
    'cheerio',
    'chromadb',
    'cohere-ai',
    'd3-dsv',
    'faiss-node',
    'form-data',
    'google-auth-library',
    'graphql',
    'html-to-text',
    'ioredis',
    'langchain',
    'langfuse',
    'langsmith',
    'langwatch',
    'linkifyjs',
    'lunary',
    'mammoth',
    'moment',
    'mongodb',
    'mysql2',
    'node-fetch',
    'node-html-markdown',
    'notion-to-md',
    'openai',
    'pdf-parse',
    'pdfjs-dist',
    'pg',
    'playwright',
    'puppeteer',
    'redis',
    'replicate',
    'srt-parser-2',
    'typeorm',
    'weaviate-ts-client'
]

export const defaultAllowBuiltInDep = [
    'assert',
    'buffer',
    'crypto',
    'events',
    'http',
    'https',
    'net',
    'path',
    'querystring',
    'timers',
    'tls',
    'url',
    'zlib'
]

/**
 * Get base classes of components
 *
 * @export
 * @param {any} targetClass
 * @returns {string[]}
 */
export const getBaseClasses = (targetClass: any) => {
    const baseClasses: string[] = []
    const skipClassNames = ['BaseLangChain', 'Serializable']

    if (targetClass instanceof Function) {
        let baseClass = targetClass

        while (baseClass) {
            const newBaseClass = Object.getPrototypeOf(baseClass)
            if (newBaseClass && newBaseClass !== Object && newBaseClass.name) {
                baseClass = newBaseClass
                if (!skipClassNames.includes(baseClass.name)) baseClasses.push(baseClass.name)
            } else {
                break
            }
        }
    }
    return baseClasses
}

/**
 * Serialize axios query params
 *
 * @export
 * @param {any} params
 * @param {boolean} skipIndex // Set to true if you want same params to be: param=1&param=2 instead of: param[0]=1&param[1]=2
 * @returns {string}
 */
export function serializeQueryParams(params: any, skipIndex?: boolean): string {
    const parts: any[] = []

    const encode = (val: string) => {
        return encodeURIComponent(val)
            .replace(/%3A/gi, ':')
            .replace(/%24/g, '$')
            .replace(/%2C/gi, ',')
            .replace(/%20/g, '+')
            .replace(/%5B/gi, '[')
            .replace(/%5D/gi, ']')
    }

    const convertPart = (key: string, val: any) => {
        if (val instanceof Date) val = val.toISOString()
        else if (val instanceof Object) val = JSON.stringify(val)

        parts.push(encode(key) + '=' + encode(val))
    }

    Object.entries(params).forEach(([key, val]) => {
        if (val === null || typeof val === 'undefined') return

        if (Array.isArray(val)) val.forEach((v, i) => convertPart(`${key}${skipIndex ? '' : `[${i}]`}`, v))
        else convertPart(key, val)
    })

    return parts.join('&')
}

/**
 * Handle error from try catch
 *
 * @export
 * @param {any} error
 * @returns {string}
 */
export function handleErrorMessage(error: any): string {
    let errorMessage = ''

    if (error.message) {
        errorMessage += error.message + '. '
    }

    if (error.response && error.response.data) {
        if (error.response.data.error) {
            if (typeof error.response.data.error === 'object') errorMessage += JSON.stringify(error.response.data.error) + '. '
            else if (typeof error.response.data.error === 'string') errorMessage += error.response.data.error + '. '
        } else if (error.response.data.msg) errorMessage += error.response.data.msg + '. '
        else if (error.response.data.Message) errorMessage += error.response.data.Message + '. '
        else if (typeof error.response.data === 'string') errorMessage += error.response.data + '. '
    }

    if (!errorMessage) errorMessage = 'Unexpected Error.'

    return errorMessage
}

/**
 * Returns the path of node modules package
 * @param {string} packageName
 * @returns {string}
 */
export const getNodeModulesPackagePath = (packageName: string): string => {
    const checkPaths = [
        path.join(__dirname, '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', '..', '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', '..', '..', '..', 'node_modules', packageName)
    ]
    for (const checkPath of checkPaths) {
        if (fs.existsSync(checkPath)) {
            return checkPath
        }
    }
    return ''
}

/**
 * Get input variables
 * @param {string} paramValue
 * @returns {boolean}
 */
export const getInputVariables = (paramValue: string): string[] => {
    if (typeof paramValue !== 'string') return []
    const returnVal = paramValue
    const variableStack = []
    const inputVariables = []
    let startIdx = 0
    const endIdx = returnVal.length
    while (startIdx < endIdx) {
        const substr = returnVal.substring(startIdx, startIdx + 1)
        // Check for escaped curly brackets
        if (substr === '\\' && (returnVal[startIdx + 1] === '{' || returnVal[startIdx + 1] === '}')) {
            startIdx += 2 // Skip the escaped bracket
            continue
        }
        // Store the opening double curly bracket
        if (substr === '{') {
            variableStack.push({ substr, startIdx: startIdx + 1 })
        }
        // Found the complete variable
        if (substr === '}' && variableStack.length > 0 && variableStack[variableStack.length - 1].substr === '{') {
            const variableStartIdx = variableStack[variableStack.length - 1].startIdx
            const variableEndIdx = startIdx
            const variableFullPath = returnVal.substring(variableStartIdx, variableEndIdx)
            if (!variableFullPath.includes(':')) inputVariables.push(variableFullPath)
            variableStack.pop()
        }
        startIdx += 1
    }
    return inputVariables
}

/**
 * Transform single curly braces into double curly braces if the content includes a colon.
 * @param input - The original string that may contain { ... } segments.
 * @returns The transformed string, where { ... } containing a colon has been replaced with {{ ... }}.
 */
export const transformBracesWithColon = (input: string): string => {
    // This regex uses negative lookbehind (?<!{) and negative lookahead (?!})
    // to ensure we only match single curly braces, not double ones.
    // It will match a single { that's not preceded by another {,
    // followed by any content without braces, then a single } that's not followed by another }.
    const regex = /(?<!\{)\{([^{}]*?)\}(?!\})/g

    return input.replace(regex, (match, groupContent) => {
        // groupContent is the text inside the braces `{ ... }`.

        if (groupContent.includes(':')) {
            // If there's a colon in the content, we turn { ... } into {{ ... }}
            // The match is the full string like: "{ answer: hello }"
            // groupContent is the inner part like: " answer: hello "
            return `{{${groupContent}}}`
        } else {
            // Otherwise, leave it as is
            return match
        }
    })
}

/**
 * Crawl all available urls given a domain url and limit
 * @param {string} url
 * @param {number} limit
 * @returns {string[]}
 */
export const getAvailableURLs = async (url: string, limit: number) => {
    try {
        const availableUrls: string[] = []

        console.info(`Crawling: ${url}`)
        availableUrls.push(url)

        const response = await axios.get(url)
        const $ = load(response.data)

        const relativeLinks = $("a[href^='/']")
        console.info(`Available Relative Links: ${relativeLinks.length}`)
        if (relativeLinks.length === 0) return availableUrls

        limit = Math.min(limit + 1, relativeLinks.length) // limit + 1 is because index start from 0 and index 0 is occupy by url
        console.info(`True Limit: ${limit}`)

        // availableUrls.length cannot exceed limit
        for (let i = 0; availableUrls.length < limit; i++) {
            if (i === limit) break // some links are repetitive so it won't added into the array which cause the length to be lesser
            console.info(`index: ${i}`)
            const element = relativeLinks[i]

            const relativeUrl = $(element).attr('href')
            if (!relativeUrl) continue

            const absoluteUrl = new URL(relativeUrl, url).toString()
            if (!availableUrls.includes(absoluteUrl)) {
                availableUrls.push(absoluteUrl)
                console.info(`Found unique relative link: ${absoluteUrl}`)
            }
        }

        return availableUrls
    } catch (err) {
        throw new Error(`getAvailableURLs: ${err?.message}`)
    }
}

/**
 * Search for href through htmlBody string
 * @param {string} htmlBody
 * @param {string} baseURL
 * @returns {string[]}
 */
function getURLsFromHTML(htmlBody: string, baseURL: string): string[] {
    const dom = new JSDOM(htmlBody)
    const linkElements = dom.window.document.querySelectorAll('a')
    const urls: string[] = []
    for (const linkElement of linkElements) {
        try {
            const urlObj = new URL(linkElement.href, baseURL)
            urls.push(urlObj.href)
        } catch (err) {
            if (process.env.DEBUG === 'true') console.error(`error with scraped URL: ${err.message}`)
            continue
        }
    }
    return urls
}

/**
 * Normalize URL to prevent crawling the same page
 * @param {string} urlString
 * @returns {string}
 */
function normalizeURL(urlString: string): string {
    const urlObj = new URL(urlString)
    const port = urlObj.port ? `:${urlObj.port}` : ''
    const hostPath = urlObj.hostname + port + urlObj.pathname + urlObj.search
    if (hostPath.length > 0 && hostPath.slice(-1) == '/') {
        // handling trailing slash
        return hostPath.slice(0, -1)
    }
    return hostPath
}

/**
 * Recursive crawl using normalizeURL and getURLsFromHTML
 * @param {string} baseURL
 * @param {string} currentURL
 * @param {string[]} pages
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
async function crawl(baseURL: string, currentURL: string, pages: string[], limit: number): Promise<string[]> {
    const baseURLObj = new URL(baseURL)
    const currentURLObj = new URL(currentURL)

    if (limit !== 0 && pages.length === limit) return pages

    if (baseURLObj.hostname !== currentURLObj.hostname) return pages

    const normalizeCurrentURL = baseURLObj.protocol + '//' + normalizeURL(currentURL)
    if (pages.includes(normalizeCurrentURL)) {
        return pages
    }

    pages.push(normalizeCurrentURL)

    if (process.env.DEBUG === 'true') console.info(`actively crawling ${currentURL}`)
    try {
        const resp = await fetch(currentURL)

        if (resp.status > 399) {
            if (process.env.DEBUG === 'true') console.error(`error in fetch with status code: ${resp.status}, on page: ${currentURL}`)
            return pages
        }

        const contentType: string | null = resp.headers.get('content-type')
        if ((contentType && !contentType.includes('text/html')) || !contentType) {
            if (process.env.DEBUG === 'true') console.error(`non html response, content type: ${contentType}, on page: ${currentURL}`)
            return pages
        }

        const htmlBody = await resp.text()
        const nextURLs = getURLsFromHTML(htmlBody, currentURL)
        for (const nextURL of nextURLs) {
            pages = await crawl(baseURL, nextURL, pages, limit)
        }
    } catch (err) {
        if (process.env.DEBUG === 'true') console.error(`error in fetch url: ${err.message}, on page: ${currentURL}`)
    }
    return pages
}

/**
 * Prep URL before passing into recursive crawl function
 * @param {string} stringURL
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
export async function webCrawl(stringURL: string, limit: number): Promise<string[]> {
    const URLObj = new URL(stringURL)
    const modifyURL = stringURL.slice(-1) === '/' ? stringURL.slice(0, -1) : stringURL
    return await crawl(URLObj.protocol + '//' + URLObj.hostname, modifyURL, [], limit)
}

export function getURLsFromXML(xmlBody: string, limit: number): string[] {
    const dom = new JSDOM(xmlBody, { contentType: 'text/xml' })
    const linkElements = dom.window.document.querySelectorAll('url')
    const urls: string[] = []
    for (const linkElement of linkElements) {
        const locElement = linkElement.querySelector('loc')
        if (limit !== 0 && urls.length === limit) break
        if (locElement?.textContent) {
            urls.push(locElement.textContent)
        }
    }
    return urls
}

export async function xmlScrape(currentURL: string, limit: number): Promise<string[]> {
    let urls: string[] = []
    if (process.env.DEBUG === 'true') console.info(`actively scarping ${currentURL}`)
    try {
        const resp = await fetch(currentURL)

        if (resp.status > 399) {
            if (process.env.DEBUG === 'true') console.error(`error in fetch with status code: ${resp.status}, on page: ${currentURL}`)
            return urls
        }

        const contentType: string | null = resp.headers.get('content-type')
        if ((contentType && !contentType.includes('application/xml') && !contentType.includes('text/xml')) || !contentType) {
            if (process.env.DEBUG === 'true') console.error(`non xml response, content type: ${contentType}, on page: ${currentURL}`)
            return urls
        }

        const xmlBody = await resp.text()
        urls = getURLsFromXML(xmlBody, limit)
    } catch (err) {
        if (process.env.DEBUG === 'true') console.error(`error in fetch url: ${err.message}, on page: ${currentURL}`)
    }
    return urls
}

/**
 * Get env variables
 * @param {string} name
 * @returns {string | undefined}
 */
export const getEnvironmentVariable = (name: string): string | undefined => {
    try {
        return typeof process !== 'undefined' ? process.env?.[name] : undefined
    } catch (e) {
        return undefined
    }
}

/**
 * Returns the path of encryption key
 * @returns {string}
 */
const getEncryptionKeyFilePath = (): string => {
    const checkPaths = [
        path.join(__dirname, '..', '..', 'encryption.key'),
        path.join(__dirname, '..', '..', 'server', 'encryption.key'),
        path.join(__dirname, '..', '..', '..', 'encryption.key'),
        path.join(__dirname, '..', '..', '..', 'server', 'encryption.key'),
        path.join(__dirname, '..', '..', '..', '..', 'encryption.key'),
        path.join(__dirname, '..', '..', '..', '..', 'server', 'encryption.key'),
        path.join(__dirname, '..', '..', '..', '..', '..', 'encryption.key'),
        path.join(__dirname, '..', '..', '..', '..', '..', 'server', 'encryption.key'),
        path.join(getUserHome(), '.flowise', 'encryption.key')
    ]
    for (const checkPath of checkPaths) {
        if (fs.existsSync(checkPath)) {
            return checkPath
        }
    }
    return ''
}

export const getEncryptionKeyPath = (): string => {
    return process.env.SECRETKEY_PATH ? path.join(process.env.SECRETKEY_PATH, 'encryption.key') : getEncryptionKeyFilePath()
}

/**
 * Returns the encryption key
 * @returns {Promise<string>}
 */
const getEncryptionKey = async (): Promise<string> => {
    if (process.env.FLOWISE_SECRETKEY_OVERWRITE !== undefined && process.env.FLOWISE_SECRETKEY_OVERWRITE !== '') {
        return process.env.FLOWISE_SECRETKEY_OVERWRITE
    }
    try {
        if (USE_AWS_SECRETS_MANAGER && secretsManagerClient) {
            const secretId = process.env.SECRETKEY_AWS_NAME || 'FlowiseEncryptionKey'
            const command = new GetSecretValueCommand({ SecretId: secretId })
            const response = await secretsManagerClient.send(command)

            if (response.SecretString) {
                return response.SecretString
            }
        }
        return await fs.promises.readFile(getEncryptionKeyPath(), 'utf8')
    } catch (error) {
        throw new Error(error)
    }
}

/**
 * Decrypt credential data
 * @param {string} encryptedData
 * @param {string} componentCredentialName
 * @param {IComponentCredentials} componentCredentials
 * @returns {Promise<ICommonObject>}
 */
const decryptCredentialData = async (encryptedData: string): Promise<ICommonObject> => {
    let decryptedDataStr: string

    if (USE_AWS_SECRETS_MANAGER && secretsManagerClient) {
        try {
            if (encryptedData.startsWith('FlowiseCredential_')) {
                const command = new GetSecretValueCommand({ SecretId: encryptedData })
                const response = await secretsManagerClient.send(command)

                if (response.SecretString) {
                    const secretObj = JSON.parse(response.SecretString)
                    decryptedDataStr = JSON.stringify(secretObj)
                } else {
                    throw new Error('Failed to retrieve secret value.')
                }
            } else {
                const encryptKey = await getEncryptionKey()
                const decryptedData = AES.decrypt(encryptedData, encryptKey)
                decryptedDataStr = decryptedData.toString(enc.Utf8)
            }
        } catch (error) {
            console.error(error)
            throw new Error('Failed to decrypt credential data.')
        }
    } else {
        // Fallback to existing code
        const encryptKey = await getEncryptionKey()
        const decryptedData = AES.decrypt(encryptedData, encryptKey)
        decryptedDataStr = decryptedData.toString(enc.Utf8)
    }

    if (!decryptedDataStr) return {}
    try {
        return JSON.parse(decryptedDataStr)
    } catch (e) {
        console.error(e)
        throw new Error('Credentials could not be decrypted.')
    }
}

/**
 * Get credential data
 * @param {string} selectedCredentialId
 * @param {ICommonObject} options
 * @returns {Promise<ICommonObject>}
 */
export const getCredentialData = async (selectedCredentialId: string, options: ICommonObject): Promise<ICommonObject> => {
    const appDataSource = options.appDataSource as DataSource
    const databaseEntities = options.databaseEntities as IDatabaseEntity

    try {
        if (!selectedCredentialId) {
            return {}
        }

        const credential = await appDataSource.getRepository(databaseEntities['Credential']).findOneBy({
            id: selectedCredentialId
        })

        if (!credential) return {}

        // Decrypt credentialData
        const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)

        return decryptedCredentialData
    } catch (e) {
        throw new Error(e)
    }
}

/**
 * Get first non falsy value
 *
 * @param {...any} values
 *
 * @returns {any|undefined}
 */
export const defaultChain = (...values: any[]): any | undefined => {
    return values.filter(Boolean)[0]
}

export const getCredentialParam = (paramName: string, credentialData: ICommonObject, nodeData: INodeData, defaultValue?: any): any => {
    return (nodeData.inputs as ICommonObject)[paramName] ?? credentialData[paramName] ?? defaultValue ?? undefined
}

// reference https://www.freeformatter.com/json-escape.html
const jsonEscapeCharacters = [
    { escape: '"', value: 'FLOWISE_DOUBLE_QUOTE' },
    { escape: '\n', value: 'FLOWISE_NEWLINE' },
    { escape: '\b', value: 'FLOWISE_BACKSPACE' },
    { escape: '\f', value: 'FLOWISE_FORM_FEED' },
    { escape: '\r', value: 'FLOWISE_CARRIAGE_RETURN' },
    { escape: '\t', value: 'FLOWISE_TAB' },
    { escape: '\\', value: 'FLOWISE_BACKSLASH' }
]

function handleEscapesJSONParse(input: string, reverse: Boolean): string {
    for (const element of jsonEscapeCharacters) {
        input = reverse ? input.replaceAll(element.value, element.escape) : input.replaceAll(element.escape, element.value)
    }
    return input
}

function iterateEscapesJSONParse(input: any, reverse: Boolean): any {
    for (const element in input) {
        const type = typeof input[element]
        if (type === 'string') input[element] = handleEscapesJSONParse(input[element], reverse)
        else if (type === 'object') input[element] = iterateEscapesJSONParse(input[element], reverse)
    }
    return input
}

export function handleEscapeCharacters(input: any, reverse: Boolean): any {
    const type = typeof input
    if (type === 'string') return handleEscapesJSONParse(input, reverse)
    else if (type === 'object') return iterateEscapesJSONParse(input, reverse)
    return input
}

/**
 * Get user home dir
 * @returns {string}
 */
export const getUserHome = (): string => {
    let variableName = 'HOME'
    if (process.platform === 'win32') {
        variableName = 'USERPROFILE'
    }

    if (process.env[variableName] === undefined) {
        // If for some reason the variable does not exist, fall back to current folder
        return process.cwd()
    }
    return process.env[variableName] as string
}

/**
 * Map ChatMessage to BaseMessage
 * @param {IChatMessage[]} chatmessages
 * @returns {BaseMessage[]}
 */
export const mapChatMessageToBaseMessage = async (chatmessages: any[] = [], orgId: string): Promise<BaseMessage[]> => {
    const chatHistory = []

    for (const message of chatmessages) {
        if (message.role === 'apiMessage' || message.type === 'apiMessage') {
            chatHistory.push(new AIMessage(message.content || ''))
        } else if (message.role === 'userMessage' || message.type === 'userMessage') {
            // check for image/files uploads
            if (message.fileUploads) {
                // example: [{"type":"stored-file","name":"0_DiXc4ZklSTo3M8J4.jpg","mime":"image/jpeg"}]
                try {
                    let messageWithFileUploads = ''
                    const uploads: IFileUpload[] = JSON.parse(message.fileUploads)
                    const imageContents: MessageContentImageUrl[] = []
                    for (const upload of uploads) {
                        if (upload.type === 'stored-file' && upload.mime.startsWith('image/')) {
                            const fileData = await getFileFromStorage(upload.name, orgId, message.chatflowid, message.chatId)
                            // as the image is stored in the server, read the file and convert it to base64
                            const bf = 'data:' + upload.mime + ';base64,' + fileData.toString('base64')

                            imageContents.push({
                                type: 'image_url',
                                image_url: {
                                    url: bf
                                }
                            })
                        } else if (upload.type === 'url' && upload.mime.startsWith('image') && upload.data) {
                            imageContents.push({
                                type: 'image_url',
                                image_url: {
                                    url: upload.data
                                }
                            })
                        } else if (upload.type === 'stored-file:full') {
                            const fileLoaderNodeModule = await import('../nodes/documentloaders/File/File')
                            // @ts-ignore
                            const fileLoaderNodeInstance = new fileLoaderNodeModule.nodeClass()
                            const options = {
                                retrieveAttachmentChatId: true,
                                chatflowid: message.chatflowid,
                                chatId: message.chatId,
                                orgId
                            }
                            let fileInputFieldFromMimeType = 'txtFile'
                            fileInputFieldFromMimeType = mapMimeTypeToInputField(upload.mime)
                            const nodeData = {
                                inputs: {
                                    [fileInputFieldFromMimeType]: `FILE-STORAGE::${JSON.stringify([upload.name])}`
                                }
                            }
                            const documents: string = await fileLoaderNodeInstance.init(nodeData, '', options)
                            messageWithFileUploads += `<doc name='${upload.name}'>${handleEscapeCharacters(documents, true)}</doc>\n\n`
                        }
                    }
                    const messageContent = messageWithFileUploads ? `${messageWithFileUploads}\n\n${message.content}` : message.content
                    chatHistory.push(
                        new HumanMessage({
                            content: [
                                {
                                    type: 'text',
                                    text: messageContent
                                },
                                ...imageContents
                            ]
                        })
                    )
                } catch (e) {
                    // failed to parse fileUploads, continue with text only
                    chatHistory.push(new HumanMessage(message.content || ''))
                }
            } else {
                chatHistory.push(new HumanMessage(message.content || ''))
            }
        }
    }
    return chatHistory
}

/**
 * Convert incoming chat history to string
 * @param {IMessage[]} chatHistory
 * @returns {string}
 */
export const convertChatHistoryToText = (chatHistory: IMessage[] | { content: string; role: string }[] = []): string => {
    return chatHistory
        .map((chatMessage) => {
            if (!chatMessage) return ''
            const messageContent = 'message' in chatMessage ? chatMessage.message : chatMessage.content
            if (!messageContent || messageContent.trim() === '') return ''

            const messageType = 'type' in chatMessage ? chatMessage.type : chatMessage.role
            if (messageType === 'apiMessage' || messageType === 'assistant') {
                return `Assistant: ${messageContent}`
            } else if (messageType === 'userMessage' || messageType === 'user') {
                return `Human: ${messageContent}`
            } else {
                return `${messageContent}`
            }
        })
        .filter((message) => message !== '') // Remove empty messages
        .join('\n')
}

/**
 * Serialize array chat history to string
 * @param {string | Array<string>} chatHistory
 * @returns {string}
 */
export const serializeChatHistory = (chatHistory: string | Array<string>) => {
    if (Array.isArray(chatHistory)) {
        return chatHistory.join('\n')
    }
    return chatHistory
}

/**
 * Convert schema to zod schema
 * @param {string | object} schema
 * @returns {ICommonObject}
 */
export const convertSchemaToZod = (schema: string | object): ICommonObject => {
    try {
        const parsedSchema = typeof schema === 'string' ? JSON.parse(schema) : schema
        const zodObj: ICommonObject = {}
        for (const sch of parsedSchema) {
            if (sch.type === 'string') {
                if (sch.required) {
                    zodObj[sch.property] = z.string({ required_error: `${sch.property} required` }).describe(sch.description)
                } else {
                    zodObj[sch.property] = z.string().describe(sch.description).optional()
                }
            } else if (sch.type === 'number') {
                if (sch.required) {
                    zodObj[sch.property] = z.number({ required_error: `${sch.property} required` }).describe(sch.description)
                } else {
                    zodObj[sch.property] = z.number().describe(sch.description).optional()
                }
            } else if (sch.type === 'boolean') {
                if (sch.required) {
                    zodObj[sch.property] = z.boolean({ required_error: `${sch.property} required` }).describe(sch.description)
                } else {
                    zodObj[sch.property] = z.boolean().describe(sch.description).optional()
                }
            } else if (sch.type === 'date') {
                if (sch.required) {
                    zodObj[sch.property] = z.date({ required_error: `${sch.property} required` }).describe(sch.description)
                } else {
                    zodObj[sch.property] = z.date().describe(sch.description).optional()
                }
            }
        }
        return zodObj
    } catch (e) {
        throw new Error(e)
    }
}

/**
 * Flatten nested object
 * @param {ICommonObject} obj
 * @param {string} parentKey
 * @returns {ICommonObject}
 */
export const flattenObject = (obj: ICommonObject, parentKey?: string) => {
    let result: any = {}

    if (!obj) return result

    Object.keys(obj).forEach((key) => {
        const value = obj[key]
        const _key = parentKey ? parentKey + '.' + key : key
        if (typeof value === 'object') {
            result = { ...result, ...flattenObject(value, _key) }
        } else {
            result[_key] = value
        }
    })

    return result
}

/**
 * Convert BaseMessage to IMessage
 * @param {BaseMessage[]} messages
 * @returns {IMessage[]}
 */
export const convertBaseMessagetoIMessage = (messages: BaseMessage[]): IMessage[] => {
    const formatmessages: IMessage[] = []
    for (const m of messages) {
        if (m._getType() === 'human') {
            formatmessages.push({
                message: m.content as string,
                type: 'userMessage'
            })
        } else if (m._getType() === 'ai') {
            formatmessages.push({
                message: m.content as string,
                type: 'apiMessage'
            })
        } else if (m._getType() === 'system') {
            formatmessages.push({
                message: m.content as string,
                type: 'apiMessage'
            })
        }
    }
    return formatmessages
}

/**
 * Convert MultiOptions String to String Array
 * @param {string} inputString
 * @returns {string[]}
 */
export const convertMultiOptionsToStringArray = (inputString: string): string[] => {
    let ArrayString: string[] = []
    try {
        ArrayString = JSON.parse(inputString)
    } catch (e) {
        ArrayString = []
    }
    return ArrayString
}

/**
 * Get variables
 * @param {DataSource} appDataSource
 * @param {IDatabaseEntity} databaseEntities
 * @param {INodeData} nodeData
 */
export const getVars = async (
    appDataSource: DataSource,
    databaseEntities: IDatabaseEntity,
    nodeData: INodeData,
    options: ICommonObject
) => {
    if (!options.workspaceId) {
        return []
    }
    const variables =
        ((await appDataSource
            .getRepository(databaseEntities['Variable'])
            .findBy({ workspaceId: Equal(options.workspaceId) })) as IVariable[]) ?? []

    // override variables defined in overrideConfig
    // nodeData.inputs.vars is an Object, check each property and override the variable
    if (nodeData?.inputs?.vars) {
        for (const propertyName of Object.getOwnPropertyNames(nodeData.inputs.vars)) {
            const foundVar = variables.find((v) => v.name === propertyName)
            if (foundVar) {
                // even if the variable was defined as runtime, we override it with static value
                foundVar.type = 'static'
                foundVar.value = nodeData.inputs.vars[propertyName]
            } else {
                // add it the variables, if not found locally in the db
                variables.push({ name: propertyName, type: 'static', value: nodeData.inputs.vars[propertyName] })
            }
        }
    }

    return variables
}

/**
 * Prepare sandbox variables
 * @param {IVariable[]} variables
 */
export const prepareSandboxVars = (variables: IVariable[]) => {
    let vars = {}
    if (variables) {
        for (const item of variables) {
            let value = item.value

            // read from .env file
            if (item.type === 'runtime') {
                value = process.env[item.name] ?? ''
            }

            Object.defineProperty(vars, item.name, {
                enumerable: true,
                configurable: true,
                writable: true,
                value: value
            })
        }
    }
    return vars
}

let version: string
export const getVersion: () => Promise<{ version: string }> = async () => {
    if (version != null) return { version }

    const checkPaths = [
        path.join(__dirname, '..', 'package.json'),
        path.join(__dirname, '..', '..', 'package.json'),
        path.join(__dirname, '..', '..', '..', 'package.json'),
        path.join(__dirname, '..', '..', '..', '..', 'package.json'),
        path.join(__dirname, '..', '..', '..', '..', '..', 'package.json')
    ]
    for (const checkPath of checkPaths) {
        try {
            const content = await fs.promises.readFile(checkPath, 'utf8')
            const parsedContent = JSON.parse(content)
            version = parsedContent.version
            return { version }
        } catch {
            continue
        }
    }

    throw new Error('None of the package.json paths could be parsed')
}

/**
 * Map Ext to InputField
 * @param {string} ext
 * @returns {string}
 */
export const mapExtToInputField = (ext: string) => {
    switch (ext) {
        case '.txt':
            return 'txtFile'
        case '.pdf':
            return 'pdfFile'
        case '.json':
            return 'jsonFile'
        case '.csv':
        case '.xls':
        case '.xlsx':
            return 'csvFile'
        case '.jsonl':
            return 'jsonlinesFile'
        case '.docx':
        case '.doc':
            return 'docxFile'
        case '.yaml':
            return 'yamlFile'
        default:
            return 'txtFile'
    }
}

/**
 * Map MimeType to InputField
 * @param {string} mimeType
 * @returns {string}
 */
export const mapMimeTypeToInputField = (mimeType: string) => {
    switch (mimeType) {
        case 'text/plain':
            return 'txtFile'
        case 'application/pdf':
            return 'pdfFile'
        case 'application/json':
            return 'jsonFile'
        case 'text/csv':
            return 'csvFile'
        case 'application/json-lines':
        case 'application/jsonl':
        case 'text/jsonl':
            return 'jsonlinesFile'
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        case 'application/msword': {
            return 'docxFile'
        }
        case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        case 'application/vnd.ms-excel': {
            return 'excelFile'
        }
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        case 'application/vnd.ms-powerpoint': {
            return 'powerpointFile'
        }
        case 'application/vnd.yaml':
        case 'application/x-yaml':
        case 'text/vnd.yaml':
        case 'text/x-yaml':
        case 'text/yaml':
            return 'yamlFile'
        default:
            return 'txtFile'
    }
}

/**
 * Map MimeType to Extension
 * @param {string} mimeType
 * @returns {string}
 */
export const mapMimeTypeToExt = (mimeType: string) => {
    switch (mimeType) {
        case 'text/plain':
            return 'txt'
        case 'text/html':
            return 'html'
        case 'text/css':
            return 'css'
        case 'text/javascript':
        case 'application/javascript':
            return 'js'
        case 'text/xml':
        case 'application/xml':
            return 'xml'
        case 'text/markdown':
        case 'text/x-markdown':
            return 'md'
        case 'application/pdf':
            return 'pdf'
        case 'application/json':
            return 'json'
        case 'text/csv':
            return 'csv'
        case 'application/json-lines':
        case 'application/jsonl':
        case 'text/jsonl':
            return 'jsonl'
        case 'application/msword':
            return 'doc'
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return 'docx'
        case 'application/vnd.ms-excel':
            return 'xls'
        case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
            return 'xlsx'
        case 'application/vnd.ms-powerpoint':
            return 'ppt'
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
            return 'pptx'
        default:
            return ''
    }
}

// remove invalid markdown image pattern: ![<some-string>](<some-string>)
export const removeInvalidImageMarkdown = (output: string): string => {
    return typeof output === 'string' ? output.replace(/!\[.*?\]\((?!https?:\/\/).*?\)/g, '') : output
}

/**
 * Extract output from array
 * @param {any} output
 * @returns {string}
 */
export const extractOutputFromArray = (output: any): string => {
    if (Array.isArray(output)) {
        return output.map((o) => o.text).join('\n')
    } else if (typeof output === 'object') {
        if (output.text) return output.text
        else return JSON.stringify(output)
    }
    return output
}

/**
 * Loop through the object and replace the key with the value
 * @param {any} obj
 * @param {any} sourceObj
 * @returns {any}
 */
export const resolveFlowObjValue = (obj: any, sourceObj: any): any => {
    if (typeof obj === 'object' && obj !== null) {
        const resolved: any = Array.isArray(obj) ? [] : {}
        for (const key in obj) {
            const value = obj[key]
            resolved[key] = resolveFlowObjValue(value, sourceObj)
        }
        return resolved
    } else if (typeof obj === 'string' && obj.startsWith('$flow')) {
        return customGet(sourceObj, obj)
    } else {
        return obj
    }
}

export const handleDocumentLoaderOutput = (docs: Document[], output: string) => {
    if (output === 'document') {
        return docs
    } else {
        let finaltext = ''
        for (const doc of docs) {
            finaltext += `${doc.pageContent}\n`
        }
        return handleEscapeCharacters(finaltext, false)
    }
}

export const parseDocumentLoaderMetadata = (metadata: object | string): object => {
    if (!metadata) return {}

    if (typeof metadata !== 'object') {
        return JSON.parse(metadata)
    }

    return metadata
}

export const handleDocumentLoaderMetadata = (
    docs: Document[],
    _omitMetadataKeys: string,
    metadata: object | string = {},
    sourceIdKey?: string
) => {
    let omitMetadataKeys: string[] = []
    if (_omitMetadataKeys) {
        omitMetadataKeys = _omitMetadataKeys.split(',').map((key) => key.trim())
    }

    metadata = parseDocumentLoaderMetadata(metadata)

    return docs.map((doc) => ({
        ...doc,
        metadata:
            _omitMetadataKeys === '*'
                ? metadata
                : omit(
                      {
                          ...metadata,
                          ...doc.metadata,
                          ...(sourceIdKey ? { [sourceIdKey]: doc.metadata[sourceIdKey] || sourceIdKey } : undefined)
                      },
                      omitMetadataKeys
                  )
    }))
}

export const handleDocumentLoaderDocuments = async (loader: DocumentLoader, textSplitter?: TextSplitter) => {
    let docs: Document[] = []

    if (textSplitter) {
        let splittedDocs = await loader.load()
        splittedDocs = await textSplitter.splitDocuments(splittedDocs)
        docs = splittedDocs
    } else {
        docs = await loader.load()
    }

    return docs
}

/**
 * Normalize special characters in key to be used in vector store
 * @param str - Key to normalize
 * @returns Normalized key
 */
export const normalizeSpecialChars = (str: string) => {
    return str.replace(/[^a-zA-Z0-9_]/g, '_')
}

/**
 * recursively normalize object keys
 * @param data - Object to normalize
 * @returns Normalized object
 */
export const normalizeKeysRecursively = (data: any): any => {
    if (Array.isArray(data)) {
        return data.map(normalizeKeysRecursively)
    }

    if (data !== null && typeof data === 'object') {
        return Object.entries(data).reduce((acc, [key, value]) => {
            const newKey = normalizeSpecialChars(key)
            acc[newKey] = normalizeKeysRecursively(value)
            return acc
        }, {} as Record<string, any>)
    }
    return data
}

/**
 * Check if OAuth2 token is expired and refresh if needed
 * @param {string} credentialId
 * @param {ICommonObject} credentialData
 * @param {ICommonObject} options
 * @param {number} bufferTimeMs - Buffer time in milliseconds before expiry (default: 5 minutes)
 * @returns {Promise<ICommonObject>}
 */
export const refreshOAuth2Token = async (
    credentialId: string,
    credentialData: ICommonObject,
    options: ICommonObject,
    bufferTimeMs: number = 5 * 60 * 1000
): Promise<ICommonObject> => {
    // Check if token is expired and refresh if needed
    if (credentialData.expires_at) {
        const expiryTime = new Date(credentialData.expires_at)
        const currentTime = new Date()

        if (currentTime.getTime() > expiryTime.getTime() - bufferTimeMs) {
            if (!credentialData.refresh_token) {
                throw new Error('Access token is expired and no refresh token is available. Please re-authorize the credential.')
            }

            try {
                // Import fetch dynamically to avoid issues
                const fetch = (await import('node-fetch')).default

                // Call the refresh API endpoint
                const refreshResponse = await fetch(
                    `${options.baseURL || 'http://localhost:3000'}/api/v1/oauth2-credential/refresh/${credentialId}`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                )

                if (!refreshResponse.ok) {
                    const errorData = await refreshResponse.text()
                    throw new Error(`Failed to refresh token: ${refreshResponse.status} ${refreshResponse.statusText} - ${errorData}`)
                }

                await refreshResponse.json()

                // Get the updated credential data
                const updatedCredentialData = await getCredentialData(credentialId, options)

                return updatedCredentialData
            } catch (error) {
                console.error('Failed to refresh access token:', error)
                throw new Error(
                    `Failed to refresh access token: ${
                        error instanceof Error ? error.message : 'Unknown error'
                    }. Please re-authorize the credential.`
                )
            }
        }
    }

    // Token is not expired, return original data
    return credentialData
}

export const stripHTMLFromToolInput = (input: string) => {
    const turndownService = new TurndownService()
    let cleanedInput = turndownService.turndown(input)
    // After conversion, replace any escaped underscores with regular underscores
    cleanedInput = cleanedInput.replace(/\\_/g, '_')
    return cleanedInput
}

// Helper function to convert require statements to ESM imports
const convertRequireToImport = (requireLine: string): string | null => {
    // Remove leading/trailing whitespace and get the indentation
    const indent = requireLine.match(/^(\s*)/)?.[1] || ''
    const trimmed = requireLine.trim()

    // Match patterns like: const/let/var name = require('module')
    const defaultRequireMatch = trimmed.match(/^(const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/)
    if (defaultRequireMatch) {
        const [, , varName, moduleName] = defaultRequireMatch
        return `${indent}import ${varName} from '${moduleName}';`
    }

    // Match patterns like: const { name1, name2 } = require('module')
    const destructureMatch = trimmed.match(/^(const|let|var)\s+\{\s*([^}]+)\s*\}\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/)
    if (destructureMatch) {
        const [, , destructuredVars, moduleName] = destructureMatch
        return `${indent}import { ${destructuredVars.trim()} } from '${moduleName}';`
    }

    // Match patterns like: const name = require('module').property
    const propertyMatch = trimmed.match(/^(const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\.(\w+)/)
    if (propertyMatch) {
        const [, , varName, moduleName, property] = propertyMatch
        return `${indent}import { ${property} as ${varName} } from '${moduleName}';`
    }

    // If no pattern matches, return null to skip conversion
    return null
}

/**
 * Execute JavaScript code using either Sandbox or NodeVM
 * @param {string} code - The JavaScript code to execute
 * @param {ICommonObject} sandbox - The sandbox object with variables
 * @param {ICommonObject} options - Execution options
 * @returns {Promise<any>} - The execution result
 */
export const executeJavaScriptCode = async (
    code: string,
    sandbox: ICommonObject,
    options: {
        timeout?: number
        useSandbox?: boolean
        libraries?: string[]
        streamOutput?: (output: string) => void
        nodeVMOptions?: ICommonObject
    } = {}
): Promise<any> => {
    const { timeout = 10000, useSandbox = true, streamOutput, libraries = [], nodeVMOptions = {} } = options
    const shouldUseSandbox = useSandbox && process.env.E2B_APIKEY

    if (shouldUseSandbox) {
        try {
            const variableDeclarations = []

            if (sandbox['$vars']) {
                variableDeclarations.push(`const $vars = ${JSON.stringify(sandbox['$vars'])};`)
            }

            if (sandbox['$flow']) {
                variableDeclarations.push(`const $flow = ${JSON.stringify(sandbox['$flow'])};`)
            }

            // Add other sandbox variables
            for (const [key, value] of Object.entries(sandbox)) {
                if (
                    key !== '$vars' &&
                    key !== '$flow' &&
                    key !== 'util' &&
                    key !== 'Symbol' &&
                    key !== 'child_process' &&
                    key !== 'fs' &&
                    key !== 'process'
                ) {
                    variableDeclarations.push(`const ${key} = ${JSON.stringify(value)};`)
                }
            }

            // Handle import statements properly - they must be at the top
            const lines = code.split('\n')
            const importLines = []
            const otherLines = []

            for (const line of lines) {
                const trimmedLine = line.trim()

                // Skip node-fetch imports since Node.js has built-in fetch
                if (trimmedLine.includes('node-fetch') || trimmedLine.includes("'fetch'") || trimmedLine.includes('"fetch"')) {
                    continue // Skip this line entirely
                }

                // Check for existing ES6 imports and exports
                if (trimmedLine.startsWith('import ') || trimmedLine.startsWith('export ')) {
                    importLines.push(line)
                }
                // Check for CommonJS require statements and convert them to ESM imports
                else if (/^(const|let|var)\s+.*=\s*require\s*\(/.test(trimmedLine)) {
                    const convertedImport = convertRequireToImport(trimmedLine)
                    if (convertedImport) {
                        importLines.push(convertedImport)
                    }
                } else {
                    otherLines.push(line)
                }
            }

            const sbx = await Sandbox.create({ apiKey: process.env.E2B_APIKEY })

            // Install libraries
            for (const library of libraries) {
                await sbx.commands.run(`npm install ${library}`)
            }

            // Separate imports from the rest of the code for proper ES6 module structure
            const codeWithImports = [
                ...importLines,
                `module.exports = async function() {`,
                ...variableDeclarations,
                ...otherLines,
                `}()`
            ].join('\n')

            const execution = await sbx.runCode(codeWithImports, { language: 'js' })

            let output = ''

            if (execution.text) output = execution.text
            if (!execution.text && execution.logs.stdout.length) output = execution.logs.stdout.join('\n')

            if (execution.error) {
                throw new Error(`${execution.error.name}: ${execution.error.value}`)
            }

            if (execution.logs.stderr.length) {
                throw new Error(execution.logs.stderr.join('\n'))
            }

            // Stream output if streaming function provided
            if (streamOutput && output) {
                streamOutput(output)
            }

            // Clean up sandbox
            sbx.kill()

            return output
        } catch (e) {
            throw new Error(`Sandbox Execution Error: ${e}`)
        }
    } else {
        const builtinDeps = process.env.TOOL_FUNCTION_BUILTIN_DEP
            ? defaultAllowBuiltInDep.concat(process.env.TOOL_FUNCTION_BUILTIN_DEP.split(','))
            : defaultAllowBuiltInDep
        const externalDeps = process.env.TOOL_FUNCTION_EXTERNAL_DEP ? process.env.TOOL_FUNCTION_EXTERNAL_DEP.split(',') : []
        const deps = availableDependencies.concat(externalDeps)

        const defaultNodeVMOptions: any = {
            console: 'inherit',
            sandbox,
            require: {
                external: { modules: deps },
                builtin: builtinDeps
            },
            eval: false,
            wasm: false,
            timeout
        }

        // Merge with custom nodeVMOptions if provided
        const finalNodeVMOptions = { ...defaultNodeVMOptions, ...nodeVMOptions }

        const vm = new NodeVM(finalNodeVMOptions)

        try {
            const response = await vm.run(`module.exports = async function() {${code}}()`, __dirname)

            let finalOutput = response
            if (typeof response === 'object') {
                finalOutput = JSON.stringify(response, null, 2)
            }

            // Stream output if streaming function provided
            if (streamOutput && finalOutput) {
                streamOutput(finalOutput)
            }

            return finalOutput
        } catch (e) {
            throw new Error(`NodeVM Execution Error: ${e}`)
        }
    }
}

/**
 * Create a standard sandbox object for code execution
 * @param {string} input - The input string
 * @param {ICommonObject} variables - Variables from getVars
 * @param {ICommonObject} flow - Flow object with chatflowId, sessionId, etc.
 * @param {ICommonObject} additionalSandbox - Additional sandbox variables
 * @returns {ICommonObject} - The sandbox object
 */
export const createCodeExecutionSandbox = (
    input: string,
    variables: IVariable[],
    flow: ICommonObject,
    additionalSandbox: ICommonObject = {}
): ICommonObject => {
    const sandbox: ICommonObject = {
        $input: input,
        util: undefined,
        Symbol: undefined,
        child_process: undefined,
        fs: undefined,
        process: undefined,
        ...additionalSandbox
    }

    sandbox['$vars'] = prepareSandboxVars(variables)
    sandbox['$flow'] = flow

    return sandbox
}
