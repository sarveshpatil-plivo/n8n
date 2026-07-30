import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { plivoApiRequest } from './GenericFunctions';
import { verifyPlivoSignature, detectEventType } from './PlivoTriggerHelpers';

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
					{
						name: 'SMS Delivery Status',
						value: 'smsStatus',
						description: 'Trigger when an SMS delivery status update is received',
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
				displayName: 'Validate Signature',
				name: 'validateSignature',
				type: 'boolean',
				default: true,
				description:
					'Whether to validate the X-Plivo-Signature-V3 header to ensure requests are from Plivo',
			},
			{
				displayName:
					'While this workflow is active, the selected Plivo number(s) are automatically pointed at this webhook and restored when it is deactivated. SMS delivery status is delivered to the callback URL on your outbound Message API request, not configured here.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return this.getWorkflowStaticData('node').managedApps !== undefined;
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

				const managedApps: IDataObject = {};
				const previousApps: IDataObject = {};

				for (const number of phoneNumbers) {
					const num = number.replace(/\D/g, '');
					const appName = `n8n-plivo-trigger-${num}`;

					const numberInfo = await plivoApiRequest.call(this, 'GET', `/Number/${num}`);
					const currentAppId = numberInfo.application
						? String(numberInfo.application).split('/').filter(Boolean).pop()
						: '';

					let appId = '';
					if (currentAppId) {
						const currentApp = await plivoApiRequest.call(
							this,
							'GET',
							`/Application/${currentAppId}`,
						);
						if (currentApp.app_name === appName) {
							appId = currentAppId;
						} else {
							previousApps[number] = currentAppId;
						}
					}

					if (!appId) {
						const created = await plivoApiRequest.call(this, 'POST', '/Application', {
							app_name: appName,
						});
						appId = created.app_id;
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

					managedApps[number] = appId;
				}

				staticData.managedApps = managedApps;
				staticData.previousApps = previousApps;
				staticData.events = events;

				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const managedApps = (staticData.managedApps as IDataObject) ?? {};
				const previousApps = (staticData.previousApps as IDataObject) ?? {};
				const events = (staticData.events as string[]) ?? [];

				const clearSms = events.includes('incomingSms');
				const clearCall = events.includes('incomingCall');

				for (const number of Object.keys(managedApps)) {
					const num = number.replace(/\D/g, '');
					const appId = managedApps[number] as string;

					const cleared: IDataObject = {};
					if (clearSms) {
						cleared.message_url = '';
					}
					if (clearCall) {
						cleared.answer_url = '';
					}
					await plivoApiRequest.call(this, 'POST', `/Application/${appId}`, cleared);

					const app = await plivoApiRequest.call(this, 'GET', `/Application/${appId}`);
					if (!app.message_url && !app.answer_url) {
						const previousAppId = previousApps[number] as string;
						if (previousAppId) {
							await plivoApiRequest.call(this, 'POST', `/Number/${num}`, {
								app_id: previousAppId,
							});
						}
						await plivoApiRequest.call(this, 'DELETE', `/Application/${appId}`);
					}
				}

				delete staticData.managedApps;
				delete staticData.previousApps;
				delete staticData.events;

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

		return {
			workflowData: [this.helpers.returnJsonArray(returnData)],
		};
	}
}
