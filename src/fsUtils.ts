import { promises } from 'fs'

const readdir = promises.readdir
const readFile = promises.readFile
const lstat = promises.lstat

export const grep = (pattern: RegExp, where: string, recursive: boolean = true, lineNumber: boolean = false): Promise<string[]> => lstat(where).then(stats => stats.isDirectory())
    .then(async isDirectory => {
        if (isDirectory) {
            if (!recursive) return Promise.resolve([`grep: ${where}: Is a directory`])
            const files = await readdir(where)
            const results = await Promise.all(
                files.map(
                    name => grep(pattern, `${where}/${name}`, recursive, lineNumber))
            )
            return results.reduce((previous, current) => {
                if (current.length != 0)
                    return previous.concat(current)
                return previous
            }, (<string[]>[]))
        } else {
            const data = await readFile(where, { encoding: 'utf-8' })
            const matched = data.split('\n').map((line, index) => { return { line, index }}).filter(line => pattern.test(line.line))
            let toReturn: string[]
            if (lineNumber) {
                toReturn = matched.map(line => `${line.index + 1}:${line.line}`)
            } else {
                toReturn  = matched.map(line => line.line)
            }
            if(recursive) {
                toReturn = toReturn.map(line => `${where}:${line}`)
            }
            return toReturn
        }
    })

export const dataToLines = (handler: (lines: string[]) => void) => {
    let currentOutput = ""
    return (data: Buffer) => {
        currentOutput += data.toString()
        let lines: string[] = []
        while(currentOutput.indexOf('\n') != -1) {
            lines.push(currentOutput.substring(0, currentOutput.indexOf('\n')))
            currentOutput = currentOutput.substring(currentOutput.indexOf('\n') + 1, currentOutput.length)
        }
        if(lines.length != 0)
            handler(lines)
    }
}