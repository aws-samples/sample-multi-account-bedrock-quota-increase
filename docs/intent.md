


How about we put together a script which automates the process? Here's how you'll use it.
 npx github:username/repo-name --accounts 123123123123,23423341331,134141412 --llm global.example.model --justification `#Example Justication \n We expect massive adoption of our new product` 
We can keep it updated so that each time a new model comes out, you'll just run the command with the new llm inference profile. In the script if you don't supply an llm argument, you'll be able to pick from a list.
We could also let you select accounts by AWS organizational unit or tag if that's easier too.


 Dynamic — Pass SSO Start URL as an Argument
If you don't want to pre-configure 30 profiles, you can dynamically discover accounts and roles :Bash script to ru...
Running Scripts A...

bash





#!/bin/bash

SSO_START_URL="${1:?Usage: $0 <sso-start-url> <role-name> <quota-code> <desired-value>}"
ROLE_NAME="${2:?Provide the SSO role name}"
QUOTA_CODE="${3:?Provide the Service Quotas quota code}"
DESIRED_VALUE="${4:?Provide the desired quota value}"
SSO_REGION="${SSO_REGION:-us-east-1}"
TARGET_REGION="${TARGET_REGION:-us-east-1}"

# Login and get access token
aws sso login --sso-session my-sso 2>/dev/null

# Get the cached SSO access token
ACCESS_TOKEN=$(find ~/.aws/sso/cache -name "*.json" -newer ~/.aws/sso/cache \
  -exec cat {} \; 2>/dev/null | jq -r 'select(.accessToken) | .accessToken' | head -1)

if [ -z "$ACCESS_TOKEN" ]; then
  echo "ERROR: No valid SSO token found. Run 'aws sso login' first."
  exit 1
fi

# List all accounts the user has access to
ACCOUNTS=$(aws sso list-accounts \
  --access-token "$ACCESS_TOKEN" \
  --region "$SSO_REGION" \
  --query 'accountList[].accountId' \
  --output text)

echo "Found accounts: $(echo $ACCOUNTS | wc -w)"

for ACCOUNT_ID in $ACCOUNTS; do
  echo "---"
  echo "Processing account: $ACCOUNT_ID"

  # Get temporary credentials for this account/role
  CREDS=$(aws sso get-role-credentials \
    --account-id "$ACCOUNT_ID" \
    --role-name "$ROLE_NAME" \
    --access-token "$ACCESS_TOKEN" \
    --region "$SSO_REGION" \
    --query 'roleCredentials' \
    --output json 2>/dev/null)

  if [ $? -ne 0 ]; then
    echo "  SKIPPED: Cannot assume $ROLE_NAME in $ACCOUNT_ID"
    continue
  fi

  # Export credentials
  export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r '.accessKeyId')
Usage:

bash





./request-quota.sh https://my-org.awsapps.com/start AdministratorAccess L-XXXXXXXX 500000
