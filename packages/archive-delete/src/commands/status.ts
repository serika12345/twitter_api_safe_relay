import { type JobOptions, loadJob, printJobStatus } from "../job.ts";

export const runStatus = async (options: JobOptions) => {
	printJobStatus(await loadJob(options));
};
