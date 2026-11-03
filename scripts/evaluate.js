const baseUrl = process.env.MOODIFY_URL || "http://localhost:3000";

async function main() {
  const response = await fetch(`${baseUrl}/api/evaluation`);
  const report = await response.json();
  if (!response.ok) throw new Error(report.error || "Evaluation request failed");
  console.log(`Moodify AI benchmark: ${report.promptCount} prompts, ${report.catalogueCount} songs`);
  console.log(`Moodify relevance: ${report.metrics.moodify.percentage}%`);
  console.log(`Popularity baseline: ${report.metrics.baseline.percentage}%`);
  for (const dimension of ["mood", "language", "activity"]) {
    console.log(`${dimension}: Moodify ${report.metrics.moodify.totals[dimension]}/${report.promptCount}; baseline ${report.metrics.baseline.totals[dimension]}/${report.promptCount}`);
  }
}

main().catch((error) => {
  console.error(`Evaluation unavailable: ${error.message}`);
  console.error("Start the app with `npm start`, then run `npm run evaluate`.");
  process.exitCode = 1;
});
