/**
 * GraphQL documents, every one of them executed against the live API during
 * the build (see docs/REMIND-API.md for the capture log). Field selections are
 * taken from introspection — Remind reports an unknown field as a *500-backed*
 * `GRAPHQL_VALIDATION_FAILED`, not a helpful "no such field", so guessing is
 * expensive and these should not be edited without re-running them.
 */

export const ME = /* GraphQL */ `
  query RemindMe {
    me {
      uuid
      id
      first_name
      last_name
      display_name
      email
      locale
      is_admin
      is_child
      created_at
      sign_in_count
    }
  }
`;

export const NAVIGATION_LIST = /* GraphQL */ `
  query RemindNavigationList($query: String, $lastCursor: String) {
    navigationList(query: $query, lastCursor: $lastCursor) {
      cursor
      items {
        __typename
        ... on TextHeader {
          text
        }
        ... on NavigationListEntityItem {
          type
          uuid
          title
          subtitle
          isRostered
          unreadsCount
        }
      }
    }
  }
`;

export const CLASSES = /* GraphQL */ `
  query RemindClasses($uuids: [String!]) {
    classes(uuids: $uuids) {
      uuid
      id
      code
      name
      displayName
      className
      type
      messagesCount
      unreadMessagesCount
      subscribersCount
      membershipsCount
      ownersCount
      createdAt
      archivedAt
      messageHistoryEnabled
      isMember
      joinUrl
      subscriberInitiatedChats
      canEditInfo
      canAddOwners
    }
  }
`;

export const CHAT_STREAMS = /* GraphQL */ `
  query RemindChatStreams($chatUuids: [String!], $groupId: Int, $chatQuery: String) {
    chatStreams(chatUuids: $chatUuids, groupId: $groupId, chatQuery: $chatQuery) {
      uuid
      title
      properTitle
      streamType
      type
      state
      hidden
      unreadMessagesCount
      membershipsCount
      updatedAt
      permissions {
        canSend
        canAdd
        canClose
        canLeave
        canPhone
      }
    }
  }
`;

export const CHAT_MESSAGES = /* GraphQL */ `
  query RemindChatMessages($chatUuids: [String!], $limit: Int) {
    chatStreams(chatUuids: $chatUuids) {
      uuid
      title
      unreadMessagesCount
      sequenceItems(nonGapMessagesLimit: $limit) {
        seq
        key
        item {
          __typename
          ... on MessageItem {
            uuid
            body
            type
            createdAt
            sentAt
            urgent
            publicUrl
            sender {
              uuid
              name
            }
            files {
              __typename
            }
          }
          ... on SystemMessageItem {
            uuid
            body
            createdAt
          }
          ... on GapItem {
            uuid
            size
          }
        }
      }
    }
  }
`;

export const NOTIFICATION_SETTINGS = /* GraphQL */ `
  query RemindNotificationSettings {
    accountNotificationsScreen {
      canManageReplies
      repliesEnabled
      canManageAnnouncementCopies
      announcementCopiesEnabled
      canManageCalls
      allowsIncomingCalls
      showLimitedSmsNotificationsWarning
      devices {
        id
        type
        title
        deliveryDescription
        isEnabled
        isPendingConfirmation
        isPreferredVoiceCallsDevice
      }
    }
  }
`;

export const UPDATE_NOTIFICATIONS = /* GraphQL */ `
  mutation RemindUpdateNotifications($input: UpdateAccountNotificationsScreenInput!) {
    updateAccountNotificationsScreen(input: $input) {
      __typename
    }
  }
`;

export const PUT_MESSAGE = /* GraphQL */ `
  mutation RemindPutMessage($input: PutMessageInput!) {
    putMessage(input: $input) {
      error {
        __typename
      }
      messages {
        __typename
      }
    }
  }
`;
