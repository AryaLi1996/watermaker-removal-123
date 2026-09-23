# CI deploy setup for the cloud inpaint service

`.github/workflows/deploy-inpaint.yml` runs `scripts/deploy-inpaint.sh` on
every push to `main` that touches `services/cloud-inpaint/**`, and on a manual
`workflow_dispatch`. It authenticates to AWS via GitHub's OIDC provider — no
long-lived AWS access keys are stored in GitHub — which means IAM roles have to
exist first, trusted specifically by this repo. **This is one-time AWS and
GitHub setup, and none of it can be done from here:** it needs the AWS and
GitHub consoles for account `677840207937`.

Until it is done, every run fails at **Check required secrets are configured**
and names what is missing. That failure is incomplete setup, not a broken
workflow.

The workflow is split into three jobs so no single job holds both the ability
to see production and the ability to change it:

| Job | AWS role | Can it change production? | Gate |
|---|---|---|---|
| `test`  | none — no `id-token` permission at all | no | — |
| `plan`  | `AWS_INPAINT_PLAN_ROLE_ARN` (§2c) — no `ExecuteChangeSet`, no `DeleteStack` | **no** | — |
| `apply` | `AWS_INPAINT_DEPLOY_ROLE_ARN` (§2b) | yes | `inpaint-production` reviewers |

Set up **both** roles — the workflow fails at `plan` if only the deploy role
exists.

## 0. Which account, and why not the licence one

This stack deploys to **`677840207937`**. The licence service lives in
`641628981129` and stays there.

Keeping them apart is the point. This service is reachable by anyone who can
reach a URL — that is what a Lambda Function URL is — and the thing guarding it
is a token (`auth.py`). The licence account holds the DynamoDB tables with
every licence, order and trial record. A compromise of a public inference
endpoint should not be able to walk to those, and with two accounts it cannot,
whatever the IAM policies say.

`scripts/deploy-inpaint.sh` enforces this with an `EXPECTED_ACCOUNT` guard: a
mis-set profile or a role in the wrong account fails before `sam build` runs.

## 1. AWS IAM OIDC identity provider (one per AWS account)

Account `677840207937` is a different account from the licence service's, so it
needs its own provider even though that one already has one. Check:

```bash
aws iam list-open-id-connect-providers
```

If `token.actions.githubusercontent.com` is not listed:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

## 2. IAM roles this workflow assumes

Two roles, one per AWS-touching job, differing **only** in permission policy
and in the `sub` their trust policy accepts.

### 2a. Trust policies

Scoped to this exact repo and to the GitHub Environment the job names, so no
other repo, branch or job can assume either role. Create the same shape twice,
changing only the `environment:` suffix — `inpaint-plan` for the plan role,
`inpaint-production` for the deploy role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::677840207937:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:AryaLi1996/watermaker-removal-123:environment:inpaint-production",
            "repo:AryaLi1996@82909467/watermaker-removal-123@1344898575:environment:inpaint-production"
          ]
        }
      }
    }
  ]
}
```

**Both forms are listed on purpose, and this is not belt-and-braces padding.**
GitHub stamps the stable numeric owner and repo IDs into the `sub` claim for
repositories (or owners) that have ever been renamed, permanently and for every
token afterwards. The licence service's setup learned this the hard way: its
trust policy needs `AryaLi1996@82909467/ruanjian123@1335383385` and the plain
form never matches. Whether *this* repo has been renamed is not something the
API will tell you, so both are allowed — `StringLike` takes a list with OR
semantics, and the unused entry matches nothing. The IDs above are this repo's
real ones (owner `82909467`, repo `1344898575`).

If both entries somehow fail, read the claim your run actually presented
straight out of CloudTrail rather than guessing:

```bash
aws cloudtrail lookup-events --region us-east-1 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --max-results 5 --query 'Events[*].Username' --output text
```

**The `environment:` form does not encode the branch.** A `sub` of
`...:ref:refs/heads/main` pinned deploys to `main` in IAM itself; the
`...:environment:...` form says which environment the job named, not which ref
it ran from. Since the workflow can be started by `workflow_dispatch` from any
branch, restore that pinning on the GitHub side: **Settings → Environments →
each environment → Deployment branches → Selected branches → `main` only.**
Without it, a dispatch from any branch gets a matching `sub`. Do not skip it —
it is the only thing enforcing "production is deployed from `main`".

**Renaming an environment in the workflow means editing the trust policy in the
same change, IAM first.** Naming an environment changes the `sub` shape even
with zero protection rules configured. See the header comment in
`.github/workflows/deploy-inpaint.yml`.

### 2b. Permissions policy — deploy role (`AWS_INPAINT_DEPLOY_ROLE_ARN`)

What `sam build` / `sam deploy` needs for this template: CloudFormation on the
`shuyin-cloud-inpaint` stack, the SAM transform macro, the SAM-managed S3
bucket (`--resolve-s3`), the SAM-managed **ECR repository** (`--resolve-image-repos`
— this stack ships a container image, which the licence stack does not), the
Lambda function and its URL, the named execution role
(`CAPABILITY_NAMED_IAM`), and CloudWatch Logs. Start here and widen only if a
deploy fails on a missing permission:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationStack",
      "Effect": "Allow",
      "Action": "cloudformation:*",
      "Resource": "arn:aws:cloudformation:us-east-1:677840207937:stack/shuyin-cloud-inpaint/*"
    },
    {
      "Sid": "CloudFormationPreflight",
      "Effect": "Allow",
      "Action": ["cloudformation:ValidateTemplate", "cloudformation:DescribeStacks"],
      "Resource": "*"
    },
    {
      "Sid": "SamTransform",
      "Effect": "Allow",
      "Action": "cloudformation:CreateChangeSet",
      "Resource": "arn:aws:cloudformation:us-east-1:aws:transform/Serverless-2016-10-31"
    },
    {
      "Sid": "SamManagedBucket",
      "Effect": "Allow",
      "Action": ["s3:CreateBucket", "s3:GetBucketLocation", "s3:GetBucketPolicy",
                 "s3:PutBucketPolicy", "s3:PutBucketTagging", "s3:PutBucketVersioning",
                 "s3:PutEncryptionConfiguration", "s3:PutBucketPublicAccessBlock",
                 "s3:ListBucket", "s3:GetObject", "s3:PutObject"],
      "Resource": ["arn:aws:s3:::aws-sam-cli-managed-*", "arn:aws:s3:::aws-sam-cli-managed-*/*"]
    },
    {
      "Sid": "SamManagedEcrRepository",
      "Effect": "Allow",
      "Action": ["ecr:CreateRepository", "ecr:DescribeRepositories", "ecr:SetRepositoryPolicy",
                 "ecr:GetRepositoryPolicy", "ecr:PutLifecyclePolicy", "ecr:TagResource",
                 "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload",
                 "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
                 "ecr:BatchGetImage", "ecr:ListImages"],
      "Resource": "arn:aws:ecr:us-east-1:677840207937:repository/*"
    },
    {
      "Sid": "EcrLogin",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "LambdaFunctionAndUrl",
      "Effect": "Allow",
      "Action": ["lambda:*"],
      "Resource": "arn:aws:lambda:us-east-1:677840207937:function:shuyin-cloud-inpaint-*"
    },
    {
      "Sid": "IamRoleForLambda",
      "Effect": "Allow",
      "Action": ["iam:GetRole", "iam:CreateRole", "iam:DeleteRole", "iam:AttachRolePolicy",
                 "iam:DetachRolePolicy", "iam:ListAttachedRolePolicies", "iam:PutRolePolicy",
                 "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:PassRole", "iam:TagRole"],
      "Resource": "arn:aws:iam::677840207937:role/shuyin-cloud-inpaint-*"
    },
    {
      "Sid": "CloudWatchLogsForLambda",
      "Effect": "Allow",
      "Action": ["logs:*"],
      "Resource": [
        "arn:aws:logs:us-east-1:677840207937:log-group:/aws/lambda/shuyin-cloud-inpaint-*",
        "arn:aws:logs:us-east-1:677840207937:log-group:/aws/lambda/shuyin-cloud-inpaint-*:*"
      ]
    }
  ]
}
```

**Do not drop `SamTransform`, and note its `Resource` is in account `aws`, not
`677840207937`** — easy to typo away since every other statement is scoped to
this account. Without it `sam deploy` fails at the change-set step with
`not authorized to perform: cloudformation:CreateChangeSet on resource:
arn:aws:cloudformation:us-east-1:aws:transform/Serverless-2016-10-31`.
Everything before that — OIDC auth, `sam build`, the image push — succeeds
without it, which is what makes it easy to miss.

`ecr:GetAuthorizationToken` has to be `Resource: "*"`; the API takes no
resource. The rest of ECR is scoped to this account's repositories.

There is **no DynamoDB, S3-data or Secrets Manager access here at all**, unlike
the licence role, because this stack has none of those. That is worth keeping
true: if this service ever grows storage, the reason to think twice is that
this role would grow with it.

Adjust the `shuyin-cloud-inpaint-*` prefixes if you override `STACK_NAME`.

### 2c. Permissions policy — plan role (`AWS_INPAINT_PLAN_ROLE_ARN`)

Trust policy as §2a but with `:environment:inpaint-plan`, and a permission
policy that can produce a change-set and nothing else. The absence of
`cloudformation:ExecuteChangeSet`, `DeleteStack`, `UpdateStack` and
`CreateStack` is the entire point — do not add them "to make the plan job more
useful":

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ChangeSetPreviewOnly",
      "Effect": "Allow",
      "Action": ["cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet",
                 "cloudformation:ListChangeSets", "cloudformation:DescribeStacks",
                 "cloudformation:DescribeStackEvents", "cloudformation:GetTemplateSummary"],
      "Resource": "arn:aws:cloudformation:us-east-1:677840207937:stack/shuyin-cloud-inpaint/*"
    },
    {
      "Sid": "CloudFormationPreflight",
      "Effect": "Allow",
      "Action": ["cloudformation:ValidateTemplate", "cloudformation:DescribeStacks"],
      "Resource": "*"
    },
    {
      "Sid": "SamTransform",
      "Effect": "Allow",
      "Action": "cloudformation:CreateChangeSet",
      "Resource": "arn:aws:cloudformation:us-east-1:aws:transform/Serverless-2016-10-31"
    },
    {
      "Sid": "SamManagedBucketUploadOnly",
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject", "s3:PutObject"],
      "Resource": ["arn:aws:s3:::aws-sam-cli-managed-*", "arn:aws:s3:::aws-sam-cli-managed-*/*"]
    },
    {
      "Sid": "EcrPushOnly",
      "Effect": "Allow",
      "Action": ["ecr:DescribeRepositories", "ecr:BatchCheckLayerAvailability",
                 "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
                 "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage"],
      "Resource": "arn:aws:ecr:us-east-1:677840207937:repository/*"
    },
    {
      "Sid": "EcrLogin",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "ReadDeployedShape",
      "Effect": "Allow",
      "Action": ["lambda:GetFunction", "lambda:GetFunctionConfiguration",
                 "lambda:GetFunctionUrlConfig", "iam:GetRole"],
      "Resource": "*"
    }
  ]
}
```

Two things to expect the first time:

- **`s3:CreateBucket` and `ecr:CreateRepository` are deliberately absent.** With
  `--resolve-s3` and `--resolve-image-repos`, SAM creates the managed bucket and
  repository if they do not exist — so on a brand new account the plan job fails
  until one `apply` run has created them. That is the intended trade-off: a
  preview role should not be able to create infrastructure. Expect the *first*
  run to need its `apply` approved with a failed-looking plan, or run
  `scripts/deploy-inpaint.sh` once by hand from a workstation with deploy
  credentials.
- **`iam:PassRole` is absent.** CloudFormation checks it when a change-set is
  *executed*, not created. If a plan ever fails on it, add it scoped to
  `arn:aws:iam::677840207937:role/shuyin-cloud-inpaint-*`, which is still far
  short of being able to apply anything.

**The plan job still pushes a container image.** That is inherent to previewing
an image-based stack — the change-set has to reference an image that exists —
and it is why `EcrPushOnly` is here. It writes a layer nobody runs; it cannot
point the function at it.

## 3. GitHub Environments and their secrets

Create both — Settings → Environments → New environment:

| Environment          | Protection rules |
|----------------------|------------------|
| `inpaint-plan`       | Deployment branches: **Selected branches → `main`**. No reviewers — this is a secret boundary, not a gate. |
| `inpaint-production` | Deployment branches: **Selected branches → `main`**, **plus required reviewers**. This is the approval gate: until a reviewer releases the run, `AWS_INPAINT_DEPLOY_ROLE_ARN` is never issued and nothing is applied. |

Then add the secrets **on each environment** (Environment secrets), not as
repository secrets:

| Secret                          | `inpaint-plan` | `inpaint-production` | Value |
|---------------------------------|----------------|----------------------|-------|
| `AWS_INPAINT_PLAN_ROLE_ARN`     | yes            | —                    | ARN of the plan role (§2c) |
| `AWS_INPAINT_DEPLOY_ROLE_ARN`   | —              | yes                  | ARN of the deploy role (§2b) |
| `FILL_SIGNING_SECRET`           | yes            | yes                  | At least 32 characters, generated randomly. **Not** the licence signing secret. |

Generate it with something that is not a person:

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

**Why a separate secret from the licence service's.** They guard different
things and are rotated on different schedules, and rotating this one is cheap
in a way rotating the licence one is not: a fill token lives minutes, so a new
secret costs at most one export's fallback to the local filler. Sharing them
would drag this cheap rotation onto the licence service's two-step, ship-a-build-
first dance.

**Why environment secrets rather than repository secrets.** A repository secret
is readable by *any* workflow in this repo, including one added in a branch — so
the key that mints valid fill tokens would be one new workflow file away from
being printed. Scoped to an environment, only a job naming it can read it, and
`inpaint-production` additionally requires a reviewer.

**Why `plan` needs the signing secret at all.** `template.yaml`'s
`FillSigningSecret` is `NoEcho` with `MinLength: 32`, so a change-set cannot
read the deployed value back. Passing a dummy would make every plan show a
spurious parameter change and mark the function as modified — the diff would be
noise, which defeats the point of a reviewer reading it. The plan role cannot
execute anything, so the secret's presence there does not let that job ship a
deploy.

## 4. Rollout order

Every step is on the AWS/GitHub side and needs a human with those consoles.

1. **Create the OIDC provider** in `677840207937` if it is not there (§1).
2. **Create both roles** — plan (§2a with `:environment:inpaint-plan`, §2c) and
   deploy (§2a with `:environment:inpaint-production`, §2b).
3. **Create both environments** with their branch restrictions and
   `inpaint-production`'s reviewers, and add the environment secrets (§3).
4. **Merge this workflow.** The first run stops at `apply` waiting for a
   reviewer — that is the gate working. Expect `plan` to fail on the very first
   run if the SAM bucket and ECR repository do not exist yet (§2c).
5. **Read the `InpaintUrl` output** the apply job prints, and give it to the
   licence service — see `METERING_ROUTES.md`. Until that happens the stack is
   deployed and nothing reaches it: the app is only ever handed an endpoint by
   `fill/quota`, and that route does not exist yet.

## 5. What it costs

Nothing while idle, which is the reason the service is a Lambda rather than a
GPU instance (see `template.yaml`'s description).

When it runs: 10240 MB is $0.0000001667 per GB-second, so about $0.0017 a
second of inference. `ReservedConcurrency` caps how many of those can be
running at once — four, so the worst case a runaway client or a leaked token
can reach is roughly $0.007 a second, about $25 a day if it never stopped.
Small enough to survive noticing, which is the number that matters; lower it if
that is not true for you.

ECR storage for the image is about $0.10 a month per GB, and the image is
roughly 1.2 GB. Old images accumulate on every deploy — set a lifecycle policy
on the SAM-managed repository if this is deployed often.
