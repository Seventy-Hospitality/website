export interface MembershipChecker {
  hasActiveMembership(memberId: string): Promise<boolean>;
}
