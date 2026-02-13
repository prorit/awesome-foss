#!/usr/bin/env node

// update-stars.js
//
// Fetches star counts from GitHub using GraphQL API (batched queries)
// and updates each project's project.json file.
//
// Usage: GITHUB_TOKEN=<token> node dev/scripts/update-stars.js

const { readFileSync, writeFileSync, readdirSync, statSync } = require("node:fs");
const { join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..", "..");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error("❌ GITHUB_TOKEN environment variable is required");
  process.exit(1);
}

// ── GitHub GraphQL API ───────────────────────────────────────────────────────

async function fetchStarCounts(repositories) {
  // Build GraphQL query to fetch multiple repos at once
  // Format: owner/repo -> repo0: repository(owner: "owner", name: "repo") { stargazerCount }
  
  const queries = repositories.map((repo, idx) => {
    const parts = repo.url.replace("https://github.com/", "").split("/");
    if (parts.length !== 2) return null;
    const [owner, name] = parts;
    return `repo${idx}: repository(owner: "${owner}", name: "${name}") { stargazerCount }`;
  }).filter(Boolean);

  if (queries.length === 0) {
    return [];
  }

  const query = `
    query {
      ${queries.join("\n      ")}
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();

  if (result.errors) {
    console.error("GraphQL errors:", JSON.stringify(result.errors, null, 2));
  }

  // Extract star counts
  const starCounts = [];
  for (let i = 0; i < repositories.length; i++) {
    const repoData = result.data?.[`repo${i}`];
    starCounts.push(repoData?.stargazerCount ?? 0);
  }

  return starCounts;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const projectsDir = join(ROOT, "projects");

  let folders;
  try {
    folders = readdirSync(projectsDir).filter((name) =>
      statSync(join(projectsDir, name)).isDirectory()
    );
  } catch {
    console.error("❌ Could not read projects/ directory");
    process.exit(1);
  }

  console.log(`\n⭐ Updating star counts for ${folders.length} project(s)\n`);

  // Read all projects
  const projects = [];
  for (const folder of folders.sort()) {
    const jsonPath = join(projectsDir, folder, "project.json");
    try {
      const raw = readFileSync(jsonPath, "utf-8");
      const project = JSON.parse(raw);
      projects.push({ folder, path: jsonPath, data: project });
    } catch (e) {
      console.error(`  ⚠️  ${folder}: Could not read project.json - ${e.message}`);
    }
  }

  // Batch fetch star counts (GraphQL allows ~100 per request, we'll use 50 to be safe)
  const BATCH_SIZE = 50;
  let totalUpdated = 0;

  for (let i = 0; i < projects.length; i += BATCH_SIZE) {
    const batch = projects.slice(i, i + BATCH_SIZE);
    
    console.log(`  Fetching batch ${Math.floor(i / BATCH_SIZE) + 1}...`);
    
    const repositories = batch.map(p => ({ slug: p.folder, url: p.data.github_repo }));
    
    try {
      const starCounts = await fetchStarCounts(repositories);
      
      // Update project.json files
      for (let j = 0; j < batch.length; j++) {
        const { folder, path, data } = batch[j];
        const stars = starCounts[j];
        
        if (data.stars !== stars) {
          data.stars = stars;
          writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
          console.log(`  ✅ ${folder}: ${stars} stars`);
          totalUpdated++;
        } else {
          console.log(`  ⏭️  ${folder}: ${stars} stars (no change)`);
        }
      }
    } catch (e) {
      console.error(`  ❌ Batch failed: ${e.message}`);
      // Continue with next batch
    }

    // Rate limit: wait 1 second between batches
    if (i + BATCH_SIZE < projects.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log(`\n✅ Updated ${totalUpdated} project(s)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
