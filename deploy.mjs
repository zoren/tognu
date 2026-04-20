#!/usr/bin/env zx

const modifiedFiles = await $`git status --untracked-files=no --porcelain`
if (modifiedFiles.stdout.trim() !== '') {
  console.error('There are uncommitted changes')
  process.exit(1)
}

await $`npx vite build`

const patchOut = await $`npm version patch`
if (patchOut.exitCode !== 0) {
  console.error('Failed to patch version')
  console.error(patchOut.stderr)
  process.exit(1)
}
const vtag = patchOut.stdout.trim()

await $`git push --atomic origin main ${vtag}`

console.log(`Pushed version ${vtag} to main branch`)

// not syncing nginx/ as it requires sudo to reload
// rsync nginx/locations.nginx tognu@linode:app/nginx/

await $`rsync package.json package-lock.json .nvmrc station-names.json index.js ./dist tognu@linode:app/ -r`

await $`ssh tognu@linode 'cd app && nvm install && npm install --omit=dev && (pm2 restart tognu --update-env || pm2 start "npm start" --name tognu) && pm2 save'`
