import fs from 'node:fs'

const base = 'C:\\Program Files\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh-tools\\lib'
const file = base + '\\pipeline.js'
const source = fs.readFileSync(file, 'utf8')

// 找 execute 主体拿到的 exec 对象里都有什么字段
for (const needle of ['exec:', 'exec =', 'signal: ', 'log:']) {
  const index = source.indexOf(needle)
  if (index < 0) continue
  console.log(`\n=== ${needle} @${index}`)
  console.log(source.slice(Math.max(0, index - 500), index + 700).replace(/\n/g, ' '))
}
