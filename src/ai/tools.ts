import Anthropic from '@anthropic-ai/sdk';

export const tools: Anthropic.Tool[] = [
  {
    name: 'create_comcheck',
    description:
      'Create a comcheck / express code in Comdata for a dispatcher. Only call this after ALL required details have been collected and the dispatcher has explicitly confirmed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        carrier: {
          type: 'string',
          description: 'Carrier name — must be "Rex Logistics LLC" or "Cargo Rush LLC"',
        },
        payee_name: {
          type: 'string',
          description: "Driver's full name",
        },
        amount: {
          type: 'number',
          description: 'Dollar amount of the comcheck',
        },
        memo: {
          type: 'string',
          description: 'Purpose of the comcheck (e.g., lumper, fuel advance, detention)',
        },
        unit_number: {
          type: 'string',
          description: 'Truck/unit number',
        },
        reference_number: {
          type: 'string',
          description: 'Load number or reference number',
        },
      },
      required: ['carrier', 'payee_name', 'amount', 'memo', 'unit_number', 'reference_number'],
    },
  },
];

export interface CreateComcheckInput {
  carrier: string;
  payee_name: string;
  amount: number;
  memo: string;
  unit_number: string;
  reference_number: string;
}
