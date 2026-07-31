import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { plivoApiRequest } from './GenericFunctions';
import { verifyPlivoSignature, detectEventType } from './PlivoTriggerHelpers';

// Extract the n8n webhook id from a webhook URL (the stable per-node segment, so it
// survives editor/base-URL changes). Returns undefined for non-n8n URLs.
const n8nWebhookId = (url: unknown): string | undefined =>
	/\/(?:webhook|webhook-test)\/([^/?]+)/.exec(String(url ?? ''))?.[1];

export class PlivoTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Plivo Trigger',
		name: 'plivoTrigger',
		icon: { light: 'file:plivo.svg', dark: 'file:plivo.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when Plivo events occur',
		defaults: {
			name: 'Plivo Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'plivoApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Trigger On',
				name: 'events',
				type: 'multiOptions',
				options: [
					{
						name: 'Incoming Call',
						value: 'incomingCall',
						description: 'Trigger when a call is received on a Plivo number',
					},
					{
						name: 'Incoming SMS',
						value: 'incomingSms',
						description: 'Trigger when an SMS is received on a Plivo number',
					},
				],
				default: ['incomingSms'],
				required: true,
				description: 'The events to listen to',
			},
			{
				displayName: 'Phone Number(s)',
				name: 'phoneNumbers',
				type: 'string',
				typeOptions: {
					multipleValues: true,
					multipleValueButtonText: 'Add Number',
				},
				default: [],
				required: true,
				placeholder: '+14150000000',
				displayOptions: {
					show: {
						events: ['incomingSms', 'incomingCall'],
					},
				},
				description:
					'The Plivo number(s) in E.164 to receive events on, each pointed at this webhook while the workflow is active and restored when it is deactivated',
			},
			{
				displayName: 'Answer URL',
				name: 'answerUrl',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						events: ['incomingCall'],
					},
				},
				default: '',
				placeholder: 'https://example.com/answer',
				description:
					'URL that returns Plivo call-control XML. When a call comes in the workflow is triggered and Plivo is redirected here to control the call, the same as the Make a Call action node.',
			},
			{
				displayName: 'Answer Method',
				name: 'answerMethod',
				type: 'options',
				options: [
					{ name: 'POST', value: 'POST' },
					{ name: 'GET', value: 'GET' },
				],
				default: 'POST',
				displayOptions: {
					show: {
						events: ['incomingCall'],
					},
				},
				description: 'HTTP method Plivo uses to fetch the Answer URL',
			},
			{
				displayName: 'Validate Signature',
				name: 'validateSignature',
				type: 'boolean',
				default: true,
				description:
					'Whether to validate the X-Plivo-Signature-V3 header to ensure requests are from Plivo',
			},
			{
				displayName:
					'While this workflow is active, the selected Plivo number(s) are automatically pointed at this webhook and restored when it is deactivated.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				// n8n registers a separate test webhook (activation mode 'manual') alongside
				// the production one. Because a Plivo number has a single application/URL slot
				// they share, each registration is tracked under its own static-data key so a
				// test run never clobbers an active production binding.
				const key = this.getActivationMode() === 'manual' ? 'testManagedApps' : 'managedApps';
				return this.getWorkflowStaticData('node')[key] !== undefined;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const events = this.getNodeParameter('events') as string[];
				const provisionSms = events.includes('incomingSms');
				const provisionCall = events.includes('incomingCall');

				if (!provisionSms && !provisionCall) {
					return true;
				}

				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const phoneNumbers = this.getNodeParameter('phoneNumbers', []) as string[];
				const staticData = this.getWorkflowStaticData('node');
				const key = this.getActivationMode() === 'manual' ? 'testManagedApps' : 'managedApps';

				const managed: IDataObject = {};

				for (const number of phoneNumbers) {
					const num = number.replace(/\D/g, '');
					const appName = `n8n-plivo-trigger-${num}`;

					const numberInfo = await plivoApiRequest.call(this, 'GET', `/Number/${num}`);
					const currentAppId = numberInfo.application
						? String(numberInfo.application).split('/').filter(Boolean).pop()
						: '';

					let appId = '';
					let createdApp = false;
					let previousAppId = '';
					// URLs the application had before we repointed it, so a temporary test
					// registration can restore an active production binding when it ends.
					const snapshot: IDataObject = {};

					if (currentAppId) {
						// The number may reference an application that no longer exists (e.g. a
						// stale binding left by a deleted app). Treat that as unmanaged and
						// provision a fresh application instead of failing the activation.
						const currentApp = await plivoApiRequest
							.call(this, 'GET', `/Application/${currentAppId}`)
							.catch(() => undefined);
						if (currentApp?.app_name === appName) {
							// The number is already bound to an n8n Plivo Trigger. If that binding
							// belongs to a different node (a different webhook id), another active
							// workflow already owns this number for the same event — a Plivo number
							// routes each inbound type to a single URL, so refuse instead of
							// silently hijacking it.
							const myWebhookId = n8nWebhookId(webhookUrl);
							const callOwner = n8nWebhookId(currentApp.answer_url);
							const smsOwner = n8nWebhookId(currentApp.message_url);
							if (provisionCall && callOwner && callOwner !== myWebhookId) {
								throw new NodeOperationError(
									this.getNode(),
									`The number ${number} is already receiving incoming calls in another active workflow. A Plivo number can route incoming calls to only one workflow at a time — deactivate the other workflow first.`,
								);
							}
							if (provisionSms && smsOwner && smsOwner !== myWebhookId) {
								throw new NodeOperationError(
									this.getNode(),
									`The number ${number} is already receiving incoming SMS in another active workflow. A Plivo number can route incoming SMS to only one workflow at a time — deactivate the other workflow first.`,
								);
							}

							appId = currentAppId;
							snapshot.answer_url = currentApp.answer_url ?? '';
							snapshot.answer_method = currentApp.answer_method ?? 'POST';
							snapshot.message_url = currentApp.message_url ?? '';
							snapshot.message_method = currentApp.message_method ?? 'POST';
						} else if (currentApp) {
							previousAppId = currentAppId;
						}
					}

					if (!appId) {
						const created = await plivoApiRequest.call(this, 'POST', '/Application', {
							app_name: appName,
						});
						appId = created.app_id;
						createdApp = true;
						await plivoApiRequest.call(this, 'POST', `/Number/${num}`, { app_id: appId });
					}

					const urls: IDataObject = {};
					if (provisionSms) {
						urls.message_url = webhookUrl;
						urls.message_method = 'POST';
					}
					if (provisionCall) {
						urls.answer_url = webhookUrl;
						urls.answer_method = 'POST';
					}
					await plivoApiRequest.call(this, 'POST', `/Application/${appId}`, urls);

					managed[number] = { appId, createdApp, previousAppId, snapshot };
				}

				staticData[key] = managed;

				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const isTest = this.getActivationMode() === 'manual';
				const key = isTest ? 'testManagedApps' : 'managedApps';
				const managed = (staticData[key] as IDataObject) ?? {};

				for (const number of Object.keys(managed)) {
					const num = number.replace(/\D/g, '');
					const entry = managed[number] as {
						appId: string;
						createdApp: boolean;
						previousAppId: string;
						snapshot: IDataObject;
					};

					if (isTest) {
						// A test registration only borrowed the number, so put the application's
						// URLs back exactly as they were and leave everything else in place.
						await plivoApiRequest.call(this, 'POST', `/Application/${entry.appId}`, {
							answer_url: entry.snapshot.answer_url ?? '',
							answer_method: entry.snapshot.answer_method ?? 'POST',
							message_url: entry.snapshot.message_url ?? '',
							message_method: entry.snapshot.message_method ?? 'POST',
						});
						continue;
					}

					// Production teardown: clear our URLs, and if we created the application,
					// reattach any prior application to the number and delete ours.
					await plivoApiRequest.call(this, 'POST', `/Application/${entry.appId}`, {
						answer_url: '',
						message_url: '',
					});
					if (entry.createdApp) {
						if (entry.previousAppId) {
							await plivoApiRequest.call(this, 'POST', `/Number/${num}`, {
								app_id: entry.previousAppId,
							});
						}
						await plivoApiRequest.call(this, 'DELETE', `/Application/${entry.appId}`);
					}
				}

				delete staticData[key];

				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const validateSignature = this.getNodeParameter('validateSignature', true) as boolean;
		const events = this.getNodeParameter('events', []) as string[];

		// Validate signature if enabled
		if (validateSignature) {
			const isValid = await verifyPlivoSignature.call(this);
			if (!isValid) {
				const res = this.getResponseObject();
				res.status(401).send('Unauthorized: Invalid signature');
				return {
					noWebhookResponse: true,
				};
			}
		}

		const bodyData = this.getBodyData() as IDataObject;

		// Detect event type from payload
		const eventType = detectEventType(bodyData as Record<string, unknown>);

		// Check if this event type is one we're listening for
		if (!events.includes(eventType)) {
			// Silently ignore events we're not subscribed to
			return {};
		}

		// Add metadata to the response
		const returnData: IDataObject = {
			...bodyData,
			_eventType: eventType,
		};

		// Plivo answers an inbound call by fetching call-control XML from the answer
		// URL. The webhook triggers the workflow and redirects Plivo to the user's
		// Answer URL to control the call. An incoming SMS only needs a 200, which n8n
		// returns by default.
		if (eventType === 'incomingCall') {
			const answerUrl = this.getNodeParameter('answerUrl', '') as string;
			const answerMethod = this.getNodeParameter('answerMethod', 'POST') as string;
			const escapedUrl = answerUrl
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;');
			const responseXml = `<Response><Redirect method="${answerMethod}">${escapedUrl}</Redirect></Response>`;

			const res = this.getResponseObject();
			res.setHeader('Content-Type', 'text/xml');
			res.status(200).send(responseXml);
			return {
				noWebhookResponse: true,
				workflowData: [this.helpers.returnJsonArray(returnData)],
			};
		}

		return {
			workflowData: [this.helpers.returnJsonArray(returnData)],
		};
	}
}
