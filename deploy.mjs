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

// nginx/locations.nginx is included by the stint vhost from the app dir;
// tognu-restart runs nginx -t + reload, so location changes ship with deploys.
await $`rsync package.json package-lock.json station-names.json db.js index.js ingest.js journey.js ./dist ./nginx soren@stint:/srv/tognu/app/ -r`

await $`ssh soren@stint 'cd /srv/tognu/app && npm ci --omit=dev && sudo /usr/local/bin/tognu-restart'`
