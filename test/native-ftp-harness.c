// Run the production server with a deterministic socket/thread model. Model
// recently closed control connections as TIME_WAIT on the server's port.
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include "../engine/oz-code/native.c"

static FtpConfig config;
static int time_wait, active_external, reuse, opened, bound, closed, errno_value;
static int socket_failure, listen_failure, offer_client, accepted, client_closed, joined;
static void *(*pending_worker)(void *);
static void *pending_argument;

static int fake_socket(int domain,int type,int protocol) {
    assert(domain==2&&type==1&&protocol==0);
    if(socket_failure) {errno_value=24;return -1;}
    opened=1;reuse=0;return 100;
}
static int fake_option(int fd,int level,int option,const void *value,u32 size) {
    if(level==6&&option==1) {assert(fd==101);return 0;}
    assert(fd==100&&opened&&!bound);
    assert(level==0xffff&&option==4&&size==4&&*(const int *)value==1);
    reuse=1;return 0;
}
static int fake_bind(int fd,const Address *address,u32 size) {
    assert(fd==100&&opened&&size==16&&address->port==swap16(2121));
    if(active_external||(time_wait&&!reuse)) {errno_value=48;return -1;}
    bound=1;return 0;
}
static int fake_listen(int fd,int count) {
    assert(fd==100&&bound&&count==1);
    if(listen_failure) {errno_value=55;return -1;}
    return 0;
}
static int fake_close(int fd) {
    if(fd==100) {assert(opened);opened=0;if(bound)time_wait=1;bound=0;closed++;}
    else {assert(fd==101);client_closed++;}
    errno_value=999; // A later close must not replace the original startup errno.
    return 0;
}
static int fake_errno(void) {return errno_value;}
static int fake_poll(PollFd *fds,u64 count,int timeout) {
    (void)timeout;assert(count==1);
    if(fds[0].fd==100) {
        if(offer_client&&!accepted) {fds[0].revents=1;return 1;}
        config.stop=1;return 0;
    }
    if(fds[0].fd==-1&&pending_worker) {
        // Native shutdown must signal every client before joining it.
        ClientSlot *slot=pending_argument;assert(slot->config.stop==1);
        assert(!opened); // listener closes before client drain completes
        pending_worker(pending_argument);pending_worker=0;
        return 0;
    }
    fds[0].revents=fds[0].events;return 1;
}
static int fake_accept(int fd,Address *peer,u32 *size) {
    assert(fd==100&&offer_client&&!accepted);accepted=1;
    *size=16;*peer=(Address){16,2,0,0x0100007f,{0}};return 101;
}
static int fake_sockname(int fd,Address *local,u32 *size) {
    assert(fd==101);*size=16;*local=(Address){16,2,0,0x0100007f,{0}};return 0;
}
static int fake_create(u64 *thread,void *stack,void *(*worker)(void *),void *argument) {
    (void)stack;*thread=77;pending_worker=worker;pending_argument=argument;return 0;
}
static int fake_join(u64 thread,void **result) {
    (void)result;assert(thread==77&&client_closed==1&&!pending_worker);joined++;return 0;
}

int main(void) {
    // Minimal valid FTP index: root plus an empty file on one storage.
    u64 index_words[21]={0};u8 *index=(u8 *)index_words;
    index_words[0]=INDEX_MAGIC;((u32 *)index)[2]=1;((u32 *)index)[3]=48;
    index_words[2]=2;index_words[3]=64;index_words[4]=160;index_words[5]=3;index_words[6]=163;
    Node *nodes=(Node *)(index+64);
    nodes[0].child=1;nodes[0].next=NONE;
    nodes[1].child=NONE;nodes[1].next=NONE;nodes[1].type=1;nodes[1].name_offset=1;nodes[1].name_length=1;
    index[161]='x';
    Source source={1,0,0,0,0};
    FtpFunctions functions={0};
    functions.socket=fake_socket;functions.bind=fake_bind;functions.listen=fake_listen;
    functions.close=fake_close;functions.poll=fake_poll;functions.get_errno=fake_errno;
    functions.accept=fake_accept;functions.sockname=fake_sockname;
    functions.thread_create=fake_create;functions.thread_join=fake_join;
    void *slots=calloc(1,16384);assert(slots);
    u8 data[4096],ipc[8192];
    FtpConfig initial={0};initial.magic=CFG_MAGIC;initial.version=1;initial.port=2121;initial.reserved=1;
    initial.functions=&functions;initial.index=index;initial.index_bytes=163;
    initial.sources=&source;initial.source_count=1;initial.data=data;initial.data_bytes=sizeof(data);
    initial.ipc_buffer=ipc;initial.slots=slots;initial.slot_bytes=16384;

    // Compatibility without setsockopt: first run works, then TIME_WAIT rejects
    // the second bind. Assert the stage and preserved socket error are useful.
    config=initial;ftp_main(&config);assert(config.state==2&&closed==1&&!opened);
    config=initial;ftp_main(&config);
    assert(config.state==3&&config.phase==FTP_BIND&&config.native_result==48&&!opened);

    functions.setsockopt=fake_option;
    for(int game=0;game<21;game++) {
        offer_client=game==0;accepted=0;client_closed=0;joined=0;
        config=initial;ftp_main(&config);
        assert(config.state==2&&config.phase==FTP_STOPPED&&!opened&&!bound);
        assert(reuse&&time_wait);
        if(offer_client)assert(client_closed==1&&joined==1&&!pending_worker);
    }

    // Reuse must not hide a genuinely active server, or mislabel other failures.
    active_external=1;config=initial;ftp_main(&config);
    assert(config.state==3&&config.phase==FTP_BIND&&config.native_result==48&&!opened);
    active_external=0;listen_failure=1;config=initial;ftp_main(&config);
    assert(config.state==3&&config.phase==FTP_LISTEN&&config.native_result==55&&!opened);
    listen_failure=0;socket_failure=1;config=initial;ftp_main(&config);
    assert(config.state==3&&config.phase==FTP_SOCKET&&config.native_result==24&&!opened);
    socket_failure=0;config=initial;config.index_bytes=1;ftp_main(&config);
    assert(config.state==3&&config.phase==FTP_CONFIG&&config.native_result==0&&!opened);
    free(slots);
    puts("21 native FTP restarts, client drain, active-port rejection and startup diagnostics passed");
    return 0;
}
