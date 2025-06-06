# Matrix Load Generator

A flexible load testing tool for Matrix homeservers that simulates real user interactions by creating direct message conversations, group chats, and threaded conversations with configurable message patterns.

## Features

- Create multiple Matrix users for testing
- Generate direct message conversations between user pairs
- Create group chats with multiple participants
- Create channel rooms with threaded conversations
- Support for thread replies within channel rooms
- Generate realistic random messages using Faker
- Support for parallel execution via threading
- Configurable message count and frequency

## Requirements

- Python 3.8+
- Matrix homeserver with registered user accounts

## Installation

1. Install dependencies:
   ```
   pip install -r requirements.txt
   ```

## Configuration

### User Configuration

Create a CSV file with your Matrix account details. The file should contain the following columns:
- `full_user_id` - Complete Matrix IDs including the homeserver (e.g. `@username:homeserver`)
- `password` - The corresponding account passwords

Example `users.csv` file:
```csv
full_user_id,password
@example-1001:matrix.example.org,1001@ExamplePassword
@example-1002:matrix.example.org,1002@ExamplePassword
@example-1003:matrix.example.org,1003@ExamplePassword
```

A sample file `sample_users.csv` is provided for reference.

### Environment Variables

Create a `.env` file in the project directory with the following parameters:

```
MAX_MESSAGES=300
USE_THREADING=false
THREAD_ROOMS_COUNT=1
THREADS_PER_ROOM=1
REPLIES_PER_THREAD=5
```

### Configuration Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `MAX_MESSAGES` | Maximum messages to send per conversation | `300` |
| `USE_THREADING` | Enable parallel execution | `true` or `false` |
| `THREAD_ROOMS_COUNT` | Number of channel rooms to create for threaded conversations | `1` |
| `THREADS_PER_ROOM` | Number of thread roots to create in each channel room | `1` |
| `REPLIES_PER_THREAD` | Number of replies to send in each thread | `5` |

## Usage

Run the load generator with:

```
python main.py [path_to_csv]
```

If no CSV path is provided, the script will look for a file named `sample_users.csv` in the current directory.

### Usage Examples

#### Basic Usage (Sequential Processing)

1. Create `users.csv`:
```csv
full_user_id,password
@example-1001:matrix.example.org,1001_password
@example-1002:matrix.example.org,1002_password
@example-1003:matrix.example.org,1003_password
```

2. Create `.env`:
```
MAX_MESSAGES=50
USE_THREADING=false
THREAD_ROOMS_COUNT=1
THREADS_PER_ROOM=1
REPLIES_PER_THREAD=5
```

3. Run the script:
```
python main.py users.csv
```

This will:
- Load 3 user sessions from the CSV file
- Create DM conversations between each pair (user1-user2, user1-user3, user2-user3)
- Create a group chat with all three users
- Create 1 channel room for threaded conversations
- Create 1 thread root in the channel room
- Send 5 replies in the thread
- Send 50 messages in each conversation (alternating between users in DMs)
- Process conversations sequentially (one after another)

#### Advanced Usage (Parallel Processing)

1. Create `test_users.csv` with 5 users:
```csv
full_user_id,password
@user1:matrix.test.com,password1
@user2:matrix.test.com,password2
@user3:matrix.test.com,password3
@user4:matrix.test.com,password4
@user5:matrix.test.com,password5
```

2. Create `.env`:
```
MAX_MESSAGES=200
USE_THREADING=true
THREAD_ROOMS_COUNT=3
THREADS_PER_ROOM=5
REPLIES_PER_THREAD=10
```

3. Run the script with the custom CSV:
```
python main.py test_users.csv
```

This will:
- Load 5 user sessions from the CSV file
- Create DM conversations between all 10 possible user pairs
- Create a group chat with all five users
- Create 3 channel rooms for threaded conversations
- Create 5 thread roots in each channel room (15 threads total)
- Send 10 replies in each thread (150 thread messages total)
- Send 200 messages in each conversation
- Process DM conversations and thread replies in parallel using threading

## Behavior Details

### Direct Messages
- The tool creates direct message rooms between each pair of users
- Messages are sent alternately between the two users in each DM
- Random messages with varying sentence structure are generated

### Group Chat
- A group chat is created when there are 3+ users
- The first user creates the room and invites others
- All users participate in sending messages to the group
- Group names are randomly generated (e.g. "Dynamic Squad", "Brilliant Team")

### Channel Threads
- Creates channel rooms with thread functionality based on configuration
- Each channel has a randomly generated name (e.g. "Quantum Network", "Rapid Team") 
- Multiple thread roots can be created in each channel
- Users participate in thread conversations by replying to thread roots
- Thread processing can be parallelized with the `USE_THREADING` parameter

### Message Generation
- Messages are randomly generated with varying complexity
- Each message contains 1-5 sentences
- Each sentence contains 4-12 words

