export interface ComCheckRequest {
  amount: number;
  driverLastName: string;
  driverFirstName: string;
  unitNumber?: string;
  purposeCode?: string;
  feePlusLess?: string;
}

export interface ComCheckResult {
  expressCode: string;
  confirmationNumber: string;
  amount: number;
  createdAt: Date;
}

export interface LoginResult {
  success: boolean;
  message: string;
}
