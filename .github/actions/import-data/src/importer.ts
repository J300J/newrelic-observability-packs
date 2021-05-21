import { dashboardBody, importedDashboardBody } from './types/dashboardInput';
import { GraphQLClient } from 'graphql-request';
import addDashboard from './mutations/dashboard';
import addPolicy from './mutations/policy';
import { baselineMutation, outlierMutation, staticMutation } from './mutations/alerts';
import * as yargs from 'yargs';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const url = 'https://api.newrelic.com/graphql';

const client = new GraphQLClient(url, {
	headers: { 'Content-Type': 'application/json' },
});

export const importer = async (accountId: number, nrApiKey: string, dashboardPack: string): Promise<void> => {
	if (!accountId && !nrApiKey && !dashboardPack) {
		const args = yargs.options({
			accountId: {
				alias: 'id',
				demandOption: true,
				type: 'number',
				description: 'NR account id',
			},
			nrApiKey: {
				alias: 'key',
				demandOption: true,
				type: 'string',
				description: 'NR API Key',
			},
			dashboardPack: {
				alias: 'pack',
				demandOption: true,
				type: 'string',
				description: 'NR API Key',
			},
		}).argv;

		accountId = args.accountId;
		nrApiKey = args.nrApiKey;
		dashboardPack = args.dashboardPack;
	}
	client.setHeader('API-Key', nrApiKey);

	dashboardPack = dashboardPack.toLowerCase();
	const policyId = await createPolicy(accountId, dashboardPack);

	await createDashboardLocal(accountId, dashboardPack);
	await createAlertLocal(accountId, dashboardPack, policyId);
};

const createPolicy = async (accountId: number, pack: string) => {
	const policyName = `${pack.charAt(0).toUpperCase() + pack.slice(1)} default alert policy`;

	const variables = {
		accountId,
		name: policyName,
	};
	const response = await client.request(addPolicy, variables);
	return response.alertsPolicyCreate.id;
};

const createDashboardLocal = async (accountId: number, pack: string) => {
	const replacer = new RegExp('"accountId":0', 'g');

	const dir = `${__dirname}/../../../../${pack}/dashboards`;
	let importedFiles: importedDashboardBody[] = [];

	try {
		importedFiles = fs
			.readdirSync(dir)
			.filter(name => path.extname(name) === '.json')
			.map(name => require(path.join(dir, name)));
	} catch (error) {
		console.error('Dashboard files not found. Did you provide the correct pack name?');
	}

	importedFiles.forEach(async file => {
		file.permissions = 'PUBLIC_READ_WRITE';
		let stringifiedDashboard = JSON.stringify(file);
		stringifiedDashboard = stringifiedDashboard.replace(replacer, `"accountId": ${accountId}`);

		const parsedDashboard: dashboardBody = JSON.parse(stringifiedDashboard);

		const variables = {
			accountId,
			dashboard: parsedDashboard,
		};
		try {
			await client.request(addDashboard, variables);
		} catch (error) {
			console.error('Dashboard Failure: ', error.response.errors[0].message);
		}
	});
};

const createAlertLocal = async (accountId: number, pack: string, policyId: number) => {
	const variables = {
		accountId,
		condition: undefined,
		policyId,
	};

	const dir = `${__dirname}/../../../../${pack}/alerts`;
	let fileNames: string[] = [];

	try {
		fileNames = fs.readdirSync(dir).filter(name => path.extname(name) === '.yml');
	} catch (error) {
		console.error('Alert files not found. Did you provide the correct pack name?');
	}

	fileNames.forEach(async file => {
		const loadedYaml = yaml.load(fs.readFileSync(`${dir}/${file}`, 'utf-8'));
		const parsedAlert = JSON.parse(JSON.stringify(loadedYaml));

		if (parsedAlert.type === 'BASELINE') {
			const filledFile = transformData(parsedAlert);
			variables.condition = filledFile;

			try {
				await client.rawRequest(baselineMutation, variables);
			} catch (error) {
				console.error('Alert Failure: ', error.response.errors[0].message);
			}
		} else if (parsedAlert.type === 'STATIC') {
			const filledFile = transformData(parsedAlert);
			variables.condition = filledFile;

			try {
				await client.rawRequest(staticMutation, variables);
			} catch (error) {
				console.error('Alert Failure: ', error.response.errors[0].message);
			}
		} else if (parsedAlert.type === 'OUTLIER') {
			const filledFile = transformData(parsedAlert);
			variables.condition = filledFile;

			try {
				await client.rawRequest(outlierMutation, variables);
			} catch (error) {
				console.error('Alert Failure: ', error.response.errors[0].message);
			}
		}
	});
};

const transformData = (incomingFile: any) => {
	if (!incomingFile.enabled) {
		incomingFile.enabled = false;
	}

	if (incomingFile.type === 'BASELINE') {
		incomingFile.terms.forEach((term: { operator: string }) => {
			if (!term.operator) term.operator = 'ABOVE';
		});
	}

	if (incomingFile.type) {
		delete incomingFile.type;
	}

	if (incomingFile.details) {
		delete incomingFile.details;
	}

	return incomingFile;
};

export default importer;