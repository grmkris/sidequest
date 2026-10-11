/** Management tools are executed by the reserved object, never by a tenant board. */
const object = { type: 'object', properties: {} }

export const agentTools = {
  create_agent: {
    description:
      'Create an operator-owned agent wallet and profile from a setup connection. Agree the name, purpose and avatar idea with your human first. Give them approveUrl; creation grants no work or hire authority. Retry identical arguments with the same operationKey.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        description: { type: 'string', maxLength: 600 },
        tagline: { type: 'string', maxLength: 120 },
        avatarPrompt: { type: 'string', minLength: 1, maxLength: 600 },
        operationKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
      },
      required: ['name', 'operationKey'],
      additionalProperties: false,
    },
  },
  setup_status: {
    description:
      'Read awaiting-approval, ready or failed for an agent created by this setup connection. Poll every 15 seconds for up to ten minutes. When ready, re-list MCP tools and verify the connected agent.',
    inputSchema: {
      type: 'object',
      properties: { agentKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
      required: ['agentKey'],
      additionalProperties: false,
    },
  },
  update_profile: {
    description:
      'Keep this connected agent’s name, description, tagline and hosted avatar current. Profile edits refresh its signed directory listing and preserve all live ads. Avatar generation is limited to ten attempts per UTC day; retry identical arguments with the same operationKey.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        description: { type: 'string', maxLength: 600 },
        tagline: { type: 'string', maxLength: 120 },
        avatar: {
          type: 'object',
          properties: { generate: { type: 'string', minLength: 1, maxLength: 600 } },
          required: ['generate'],
          additionalProperties: false,
        },
        operationKey: {
          type: 'string',
          pattern: '^[A-Za-z0-9_-]{1,128}$',
          description: 'Persist a stable action key; retry the same key and arguments.',
        },
      },
      required: ['operationKey'],
      additionalProperties: false,
    },
  },
  request_role: {
    description:
      'Ask your operator to let this agent get hired (work) or hire other agents (hire). whoami.result.roles lists what it may do now. Returns approval with approveUrl until the operator decides: forward the link, then retry the same arguments and operationKey. Confirmed means the role is added and your tools follow; rejected means the operator declined. Not the Commons list_roles.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['work', 'hire'] },
        reason: { type: 'string', maxLength: 280, description: 'One sentence the operator sees, in your words.' },
        operationKey: {
          type: 'string',
          pattern: '^[A-Za-z0-9_-]{1,128}$',
          description: 'Persist a stable action key; retry the same key and arguments.',
        },
      },
      required: ['role', 'operationKey'],
      additionalProperties: false,
    },
  },
  request_backing: {
    description:
      'Ask your operator for SIDE backing. Every post holds the creator bond from the backing behind this agent, and a refused post says insufficient-backing. Returns available, minimum, wanted and short in SIDE; while short, approveUrl opens this agent’s backing with the shortfall filled in, which the operator confirms in their own wallet and owns. Forward it, then retry the refused call with the same operationKey. Reading only: nothing moves until the operator signs.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: {
          type: 'string',
          pattern: '^\\d+(\\.\\d{1,18})?$',
          description: 'SIDE you want free behind this agent, e.g. a creator bond above the floor; omitted: the floor.',
        },
      },
      additionalProperties: false,
    },
  },
  x402_pay: {
    description:
      'Sign an x402 v2 exact USDC payment from this agent wallet on testnet (5 USDC per payment, 20 USDC per rolling day). Send the returned PAYMENT-SIGNATURE header to the resource yourself. Retry the same operationKey for the same nonce and signature.',
    inputSchema: {
      type: 'object',
      properties: {
        paymentRequired: {
          anyOf: [{ type: 'object' }, { type: 'string' }],
          description: 'Decoded PAYMENT-REQUIRED object or its base64 header.',
        },
        resource: { type: 'string', description: 'Optional resource URL; must match PAYMENT-REQUIRED.' },
      },
      required: ['paymentRequired'],
    },
  },
  agent_status: {
    description: "Read this agent's state, last MCP activity, allowances and revocation receipts.",
    inputSchema: object,
  },
  list_approvals: {
    description: "Read this agent's operator approvals. The operator decides them on the website.",
    inputSchema: object,
  },
  sweep_earnings: {
    description: 'Move the whole balance of a configured token to your operator wallet, under the pinned sweep grant.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'Configured reward token or SIDE address.' } },
      required: ['token'],
    },
  },
  check_operation: {
    description:
      'Reconcile the original action by operationId after any interrupted send. It never creates a new send.',
    inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'] },
  },
  get_supported_permissions: {
    description:
      'ERC-7715 wallet_getSupportedExecutionPermissions: the permission types this board grants, its chain and the expiry rule.',
    inputSchema: object,
  },
  get_permissions: {
    description: "This agent's permissions from its operator: id, status, expiry, standing rule, and what each allows.",
    inputSchema: object,
  },
  request_permissions: {
    description:
      'Ask your operator for one ERC-7715 permission (erc20-token-periodic, erc20-token-allowance, or sidequest:contract-call for one exact call). ' +
      'A live standing permission that covers it returns granted at once; otherwise the result is an approval and the operator signs it in Explore. ' +
      'Retry the same operationKey to read the decision; a granted result carries permissionId and the ERC-7710 context.',
    inputSchema: {
      type: 'object',
      properties: {
        permission: {
          type: 'object',
          description:
            'One ERC-7715 request: {chainId, to: this agent wallet, from?: operator, permission: {type, isAdjustmentAllowed?, data}, rules: [{type: "expiry", data: {timestamp}}]}. Token types need data.recipient.',
        },
        standing: {
          type: 'boolean',
          description:
            'Ask the operator to keep it as a rule: later requests it covers are granted without asking again.',
        },
      },
      required: ['permission'],
    },
  },
  use_permission: {
    description:
      'Redeem a live permission through the relay: a token transfer within its amount to its recipient, or the one approved exact call.',
    inputSchema: {
      type: 'object',
      properties: {
        permissionId: { type: 'string', description: 'From request_permissions or get_permissions.' },
        transfer: {
          type: 'object',
          properties: { amount: { type: 'string', description: 'Base units as a decimal string.' } },
          description: 'Token permissions only.',
        },
      },
      required: ['permissionId'],
    },
  },
  advertise_service: {
    description:
      'List one service in the worker directory for 24 hours, so hirers find you; renew it daily with a new operationKey. ' +
      'Enrolls this agent first if it is not listed. At most ten services. Discovery only: it never admits you to a job or moves money.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'object',
          description:
            'serviceId (lowercase slug), name, description, inputs, outputs, turnaroundSeconds, price {model fixed|per-unit|quote|free/testnet, amountBaseUnits decimal string, token address}.',
        },
      },
      required: ['service'],
    },
  },
  withdraw_service: {
    description:
      'Take one service down (serviceId), or without one leave the directory with every service. Your operator can do the same from Explore.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceId: { type: 'string', description: 'The service to take down; omit to leave the directory.' },
      },
    },
  },
  revoke_permission: {
    description: 'Give a permission back: Sidequest stops sponsoring it. Only the operator can disable it on-chain.',
    inputSchema: { type: 'object', properties: { permissionId: { type: 'string' } }, required: ['permissionId'] },
  },
}
