// All selectors in one place for easy updates.
// Updated based on discovery scan of iConnectData (w6.iconnectdata.com)

export const selectors = {
  login: {
    // Step 1: User ID page (/Login/init/)
    step1: {
      usernameField: '#username',
      continueButton: '#continueBtn',
      form: '#login_form',
    },
    // Step 2: Okta Sign In page (/Login/login)
    step2: {
      usernameField: '#okta-signin-username',
      passwordField: '#okta-signin-password',
      rememberMe: '#input7',
      submitButton: '#okta-signin-submit',
      form: '#form1',
    },
    // Dashboard indicators (logged-in state)
    dashboard: {
      logoutButton: 'button:has-text("Logout")',
      dashboardUrl: '/Login/dashboard',
    },
  },

  // 2FA/MFA selectors — TODO: Update after seeing real 2FA page
  twoFactor: {
    pageIndicator: '.mfa-challenge, [data-se="factor-challenge"], .o-form-error-container:has-text("verify")',
    codeInput: 'input[name="answer"], input[name="passcode"], input[type="tel"][name="answer"]',
    sendSmsButton: '[data-se="sms-send-code"], button:has-text("Send code"), a:has-text("Send code")',
    submitButton: '[data-se="factor-verify"], input[type="submit"][value="Verify"], button:has-text("Verify")',
  },

  navigation: {
    // Express Check page is loaded via this URL after login
    expressCheckUrl: '/Login/leftNav?LVL1=manage&LVL2=express_chk',
    // The "Request Express Check Code" link in the left nav sidebar
    requestExpressCheckLink: 'a:has-text("Request Express Check Code")',
  },

  comCheck: {
    // The form lives inside an iframe at this URL
    iframeUrl: '/motrs51/Controller?XFunction=EchoRetrieveCode',

    // Form fields (inside iframe)
    deliveryType: 'select[name="delvryType"]',
    accountList: 'select[name="acctList"]',
    customerIdSelect: 'select[name="hyphenatedAccount"]',

    // Amount and fees
    amount: 'input[name="edtAmount"]',
    feePlusLess: 'input[name="edtPlusLess"]',
    purposeCode: 'input[name="edtPurpose"]',

    // Driver / trip info
    fleetCode: 'input[name="edtFleetCode"]',
    driverNumber: 'input[name="edtDriverNumber"]',
    unitNumber: 'input[name="edtUnitNumber"]',
    tripNumber: 'input[name="edtTripNumber"]',
    driverLastName: 'input[name="edtLastName"]',
    driverFirstName: 'input[name="edtFirstName"]',
    designatedLocation: 'input[name="edtDesignLocation"]',

    // Action buttons
    retrieveCodeButton: 'a:has-text("Retrieve Code")',
    displayChargesButton: 'a:has-text("Display Charges")',
    refreshButton: 'a:has-text("Refresh")',
    cancelButton: 'a:has-text("Cancel")',
  },
} as const;
